import crypto from 'node:crypto'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { WebSocketServer } from 'ws'

// PexyDrop's server never sees file contents. It only introduces devices to each
// other and relays WebRTC handshake messages; files travel device to device.

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.PORT || 4173)
const isDev = process.env.NODE_ENV === 'development'
const behindProxy = Boolean(process.env.RENDER || process.env.TRUST_PROXY)
const roomAlphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const maxFailedJoins = 8
// When a receiver can't keep up with relayed data, pause the sender's socket
// instead of buffering without limit on the server.
const relayHighWater = 8 * 1024 * 1024
const relayLowWater = 1024 * 1024
// A pairing code outlives a brief disconnect, such as a phone locking its screen.
const roomGraceMs = 2 * 60_000

const stunServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
const cloudflareKeyId = process.env.CLOUDFLARE_TURN_KEY_ID
const cloudflareToken = process.env.CLOUDFLARE_TURN_API_TOKEN
let turnCache = { servers: /** @type {object[] | null} */ (null), expires: 0 }

/** @type {Map<string, Set<Peer>>} */
const rooms = new Map()
/** @type {Map<import('ws').WebSocket, Peer>} */
const peersBySocket = new Map()

/**
 * @typedef {{ id: string, name: string, device: string, detail: string, cellular: boolean,
 *   socket: import('ws').WebSocket, networkRoom: string, codeRoom: string | null, failedJoins: number,
 *   alive: boolean, paused: boolean }} Peer
 */

// A TURN relay forwards the still-encrypted data when two devices on different
// networks can't reach each other directly. It is optional; without one, PexyDrop
// only makes direct connections.
async function iceServers() {
  const { TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL } = process.env
  if (TURN_URLS && TURN_USERNAME && TURN_CREDENTIAL) {
    return [...stunServers, { urls: TURN_URLS.split(',').map((url) => url.trim()).filter(Boolean), username: TURN_USERNAME, credential: TURN_CREDENTIAL }]
  }
  if (!cloudflareKeyId || !cloudflareToken) return stunServers
  if (turnCache.servers && Date.now() < turnCache.expires) return turnCache.servers
  try {
    const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${cloudflareKeyId}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cloudflareToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86_400 }),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error(`Cloudflare TURN responded ${response.status}`)
    const { iceServers: servers } = await response.json()
    // Browsers block port 53, so those URLs would only slow connection setup.
    const usable = servers.map((server) => ({
      ...server,
      urls: [server.urls].flat().filter((url) => !/:53(\?|$)/.test(url)),
    }))
    turnCache = { servers: [...stunServers, ...usable], expires: Date.now() + 12 * 60 * 60_000 }
  } catch (error) {
    console.warn('Could not get TURN credentials, using direct connections only:', error.message)
    turnCache = { servers: stunServers, expires: Date.now() + 60_000 }
  }
  return turnCache.servers
}

function lanAddresses() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, interfaces]) => (interfaces ?? []).map((address) => ({ name, address })))
    .filter(({ address }) => address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.'))
    .sort((first, second) => Number(/wi-?fi|wireless|wlan/i.test(second.name)) - Number(/wi-?fi|wireless|wlan/i.test(first.name)))
    .map(({ address }) => address.address)
}

function clientAddress(request) {
  const forwarded = behindProxy ? request.headers['x-forwarded-for']?.split(',')[0]?.trim() : ''
  return (forwarded || request.socket.remoteAddress || '').replace(/^::ffff:/, '')
}

function isPrivateAddress(address) {
  return address === '::1'
    || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(address)
    || /^f[cd]/i.test(address)
    || /^fe80:/i.test(address)
}

// Devices behind the same router share a public IPv4 address, or an IPv6 /64 prefix.
// When the server itself runs on the LAN, every private address is the same network.
function networkKey(address) {
  if (isPrivateAddress(address)) return 'net:lan'
  if (address.includes(':')) return `net:${address.split(':').slice(0, 4).join(':')}`
  return `net:${address}`
}

function cleanText(value) {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32)
}

function cleanName(value) {
  return cleanText(value) || 'Unnamed device'
}

function cleanDevice(value) {
  return ['phone', 'tablet', 'laptop', 'desktop'].includes(value) ? value : 'desktop'
}

function createRoomCode() {
  let code
  do {
    code = Array.from(crypto.randomBytes(6), (byte) => roomAlphabet[byte % roomAlphabet.length]).join('')
  } while (rooms.has(`code:${code}`))
  return code
}

function send(peer, message) {
  if (peer.socket.readyState === peer.socket.OPEN) peer.socket.send(JSON.stringify(message))
}

function visiblePeers(peer) {
  const visible = new Map()
  for (const key of [peer.networkRoom, peer.codeRoom]) {
    if (!key) continue
    for (const other of rooms.get(key) ?? []) {
      if (other === peer) continue
      const existing = visible.get(other.id)
      visible.set(other.id, {
        id: other.id,
        name: other.name,
        device: other.device,
        detail: other.detail,
        cellular: other.cellular,
        via: existing?.via === 'network' || key === peer.networkRoom ? 'network' : 'code',
      })
    }
  }
  return [...visible.values()]
}

function canSee(peer, other) {
  return peer.networkRoom === other.networkRoom || Boolean(peer.codeRoom && peer.codeRoom === other.codeRoom)
}

// Only devices that can already see each other may exchange messages.
function findVisible(peer, id) {
  const target = [...(rooms.get(peer.networkRoom) ?? []), ...(rooms.get(peer.codeRoom ?? '') ?? [])]
    .find((other) => other.id === id)
  return target && canSee(peer, target) ? target : undefined
}

// Binary frames carry relayed transfer data when a direct connection can't be
// made. They start with the 12-character id of the recipient, which the server
// swaps for the sender's id. The payload is encrypted by the devices.
function relayFrame(peer, raw) {
  if (raw.length < 13) return
  const target = findVisible(peer, raw.toString('latin1', 0, 12))
  if (!target || target.socket.readyState !== target.socket.OPEN) return
  raw.write(peer.id, 0, 'latin1')
  target.socket.send(raw, { binary: true })
  if (peer.paused || target.socket.bufferedAmount < relayHighWater) return
  peer.paused = true
  peer.socket.pause()
  const check = () => {
    if (target.socket.readyState === target.socket.OPEN && target.socket.bufferedAmount > relayLowWater) return void setTimeout(check, 50)
    peer.paused = false
    peer.socket.resume()
  }
  setTimeout(check, 50)
}

function broadcastRooms(...keys) {
  const affected = new Set()
  for (const key of keys) for (const member of rooms.get(key ?? '') ?? []) affected.add(member)
  for (const member of affected) send(member, { type: 'peers', peers: visiblePeers(member) })
}

function joinRoom(peer, key) {
  if (!rooms.has(key)) rooms.set(key, new Set())
  rooms.get(key).add(peer)
}

function leaveRoom(peer, key) {
  const members = rooms.get(key)
  if (!members) return
  members.delete(peer)
  if (members.size) return
  if (!key.startsWith('code:')) return rooms.delete(key)
  setTimeout(() => {
    if (rooms.get(key) === members && !members.size) rooms.delete(key)
  }, roomGraceMs).unref()
}

function dropPeer(peer) {
  const affected = [peer.networkRoom, peer.codeRoom]
  leaveRoom(peer, peer.networkRoom)
  if (peer.codeRoom) leaveRoom(peer, peer.codeRoom)
  peer.codeRoom = null
  broadcastRooms(...affected)
}

// Each browser tab keeps a private secret, and its public id is derived from it.
// That keeps the id stable across reconnects without letting anyone claim it.
function peerIdFrom(secret) {
  if (typeof secret !== 'string' || secret.length < 16 || secret.length > 128) return crypto.randomBytes(9).toString('base64url')
  return crypto.createHash('sha256').update(secret).digest('base64url').slice(0, 12)
}

function leaveCodeRoom(peer) {
  const previous = peer.codeRoom
  if (!previous) return
  leaveRoom(peer, previous)
  peer.codeRoom = null
  broadcastRooms(previous, peer.networkRoom)
}

const app = express()

app.get('/api/info', (_req, res) => {
  res.json({ addresses: behindProxy ? [] : lanAddresses(), port })
})

// The service worker normally answers this; without one, just open the app.
app.post('/share-target', (_req, res) => res.redirect(303, '/'))

const distPath = path.join(appRoot, 'dist')
app.use(express.static(distPath))
app.get('*path', (_req, res, next) => {
  res.sendFile(path.join(distPath, 'index.html'), (error) => error && next(error))
})

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 })

wss.on('connection', (socket, request) => {
  /** @type {Peer} */
  const peer = {
    id: crypto.randomBytes(9).toString('base64url'),
    name: 'Unnamed device',
    device: 'desktop',
    detail: '',
    cellular: false,
    socket,
    networkRoom: networkKey(clientAddress(request)),
    codeRoom: null,
    failedJoins: 0,
    alive: true,
    paused: false,
  }
  let introduced = false
  peersBySocket.set(socket, peer)

  socket.on('pong', () => { peer.alive = true })

  socket.on('message', (raw, isBinary) => {
    if (isBinary) {
      if (introduced) relayFrame(peer, /** @type {Buffer} */ (raw))
      return
    }
    let message
    try {
      message = JSON.parse(String(raw))
    } catch {
      return
    }

    if (message.type === 'hello' && !introduced) {
      introduced = true
      peer.id = peerIdFrom(message.secret)
      for (const [otherSocket, other] of peersBySocket) {
        if (other === peer || other.id !== peer.id) continue
        // The same tab reconnecting (phones drop sockets when they sleep or open
        // the file picker). Take over its place without announcing a departure,
        // or other devices would tear down their connection to it.
        peersBySocket.delete(otherSocket)
        leaveRoom(other, other.networkRoom)
        if (other.networkRoom !== peer.networkRoom) broadcastRooms(other.networkRoom)
        if (other.codeRoom) {
          leaveRoom(other, other.codeRoom)
          peer.codeRoom = other.codeRoom
          joinRoom(peer, peer.codeRoom)
        }
        otherSocket.terminate()
      }
      peer.name = cleanName(message.name)
      peer.device = cleanDevice(message.device)
      peer.detail = cleanText(message.detail)
      peer.cellular = message.cellular === true
      void iceServers().then((servers) => {
        if (socket.readyState !== socket.OPEN || peersBySocket.get(socket) !== peer) return
        joinRoom(peer, peer.networkRoom)
        send(peer, { type: 'welcome', id: peer.id, iceServers: servers })
        broadcastRooms(peer.networkRoom, peer.codeRoom)
      })
      return
    }
    if (!introduced) return

    switch (message.type) {
      case 'rename':
        peer.name = cleanName(message.name)
        broadcastRooms(peer.networkRoom, peer.codeRoom)
        break
      case 'status':
        peer.cellular = message.cellular === true
        broadcastRooms(peer.networkRoom, peer.codeRoom)
        break
      case 'create-room': {
        leaveCodeRoom(peer)
        const code = createRoomCode()
        peer.codeRoom = `code:${code}`
        joinRoom(peer, peer.codeRoom)
        send(peer, { type: 'room', code })
        break
      }
      case 'join-room': {
        const code = String(message.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
        const key = `code:${code}`
        if (!rooms.has(key) || code.length !== 6) {
          peer.failedJoins += 1
          send(peer, { type: 'room-error', error: 'That code is not active. Check it and try again.' })
          if (peer.failedJoins >= maxFailedJoins) socket.close(4008, 'Too many attempts')
          break
        }
        if (peer.codeRoom === key) {
          send(peer, { type: 'room', code })
          break
        }
        leaveCodeRoom(peer)
        peer.codeRoom = key
        joinRoom(peer, key)
        send(peer, { type: 'room', code })
        broadcastRooms(key)
        break
      }
      case 'leave-room':
        leaveCodeRoom(peer)
        send(peer, { type: 'room', code: null })
        break
      case 'signal': {
        const target = findVisible(peer, message.to)
        if (target) send(target, { type: 'signal', from: peer.id, data: message.data })
        break
      }
    }
  })

  socket.on('close', () => {
    if (peersBySocket.get(socket) !== peer) return
    peersBySocket.delete(socket)
    dropPeer(peer)
  })
})

// Drop devices that vanished without closing (phone locked, Wi-Fi lost) and keep
// hosting proxies from timing out idle sockets.
setInterval(() => {
  for (const [socket, peer] of peersBySocket) {
    if (!peer.alive) {
      socket.terminate()
      continue
    }
    peer.alive = false
    socket.ping()
  }
}, 25_000).unref()

server.listen(port, isDev ? '127.0.0.1' : '0.0.0.0', () => {
  console.log(`PexyDrop ready on port ${port}`)
  console.log(process.env.TURN_URLS || cloudflareKeyId ? '  Relay (TURN) enabled for devices on different networks' : '  No relay configured: devices connect directly only')
  if (!behindProxy && !isDev) {
    for (const address of lanAddresses()) console.log(`  On your Wi-Fi: http://${address}:${port}`)
  }
})
