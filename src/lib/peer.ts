export type FileMeta = { name: string; size: number; type: string }
// local: direct over the same network. internet: direct, but across networks.
// relay: through the PexyDrop server, because no direct path could be made.
export type Route = 'local' | 'internet' | 'relay'
export type TransferStatus = 'connecting' | 'waiting' | 'sending' | 'receiving' | 'done' | 'declined' | 'cancelled' | 'failed'

export type Transfer = {
  id: string
  peerId: string
  direction: 'send' | 'receive'
  files: FileMeta[]
  total: number
  transferred: number
  speed: number
  status: TransferStatus
  toDisk?: boolean
  error?: string
}

export type IncomingOffer = { id: string; peerId: string; files: FileMeta[]; total: number }

export type LinkEvents = {
  transfer: (transfer: Transfer) => void
  queued: (peerId: string, count: number) => void
  offer: (offer: IncomingOffer) => void
  offerWithdrawn: (offerId: string) => void
  file: (file: File, peerId: string) => void
  saved: (meta: FileMeta, savedAs: string, peerId: string) => void
  text: (text: string, peerId: string) => void
  route: (peerId: string, route: Route | null) => void
}

// Asks the person whether a transfer may use a route other than the local
// network (which could mean mobile data). Resolves true to go ahead.
export type ConfirmRoute = (peerId: string, route: Route, bytes: number) => Promise<boolean>

// Sends relay frames through the signaling server's WebSocket.
export type RelayTransport = {
  send: (to: string, payload: Uint8Array) => boolean
  bufferedAmount: () => number
}

type Control =
  | { t: 'offer'; id: string; files: FileMeta[]; total: number }
  | { t: 'accept'; id: string }
  | { t: 'decline'; id: string; reason?: string }
  | { t: 'cancel'; id: string }
  | { t: 'file'; id: string; index: number }
  | { t: 'file-end'; id: string; index: number }
  | { t: 'done'; id: string }
  | { t: 'received'; id: string }
  | { t: 'text'; text: string }

type Signal = {
  session: string
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
  relayKey?: string
}

type Outgoing = {
  transfer: Transfer
  cancelled: boolean
  resolve?: (reply: Control) => void
  reject?: (error: Error) => void
}

type Incoming = {
  transfer: Transfer
  index: number
  chunks: ArrayBuffer[]
  meter: Meter
  folder?: FileSystemDirectoryHandle
  writer?: FileSystemWritableFileStream
  savedAs?: string
  // Disk writes are asynchronous but chunks arrive in order, so every step for a
  // folder transfer runs through this chain.
  chain: Promise<void>
  failed: boolean
}

// 64 KiB messages are the largest size every browser's data channel accepts.
const chunkSize = 64 * 1024
const readSize = 1024 * 1024
// Chrome closes a data channel whose send queue passes 16 MiB, so stay well below.
const highWater = 8 * 1024 * 1024
const lowWater = 1024 * 1024
// On a local network a direct connection forms within a couple of seconds. If it
// hasn't by then, the network is probably blocking it, so fall back to the relay.
const directTimeout = 8000
const relayTimeout = 10_000
const defaultIceServers: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
const notResponding = "That device isn't responding. Make sure PexyDrop is open on it and its screen is on."
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function makeId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function isPrivateAddress(address: string) {
  return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(address) || /^f[cde]/i.test(address)
}

export function onCellular() {
  const connection = (navigator as Navigator & { connection?: { type?: string } }).connection
  return connection?.type === 'cellular'
}

function safeFileName(name: string) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || 'file'
}

async function createUniqueFile(folder: FileSystemDirectoryHandle, name: string) {
  const clean = safeFileName(name)
  const dot = clean.lastIndexOf('.')
  const base = dot > 0 ? clean.slice(0, dot) : clean
  const extension = dot > 0 ? clean.slice(dot) : ''
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const candidate = attempt ? `${base} (${attempt})${extension}` : clean
    try {
      await folder.getFileHandle(candidate)
    } catch (error) {
      if ((error as DOMException).name !== 'NotFoundError') throw error
      return { handle: await folder.getFileHandle(candidate, { create: true }), name: candidate }
    }
  }
  throw new Error('Too many files with that name in the folder.')
}

// Relay encryption: the two devices agree on an AES-GCM key with ECDH, so the
// server only forwards ciphertext. Plain-HTTP local hosting has no Web Crypto;
// there the relay is the laptop itself and data is sent as-is.
type RelayKeys = { pair: CryptoKeyPair | null; publicKey: string }

async function createRelayKeys(): Promise<RelayKeys> {
  if (!crypto.subtle) return { pair: null, publicKey: 'plain' }
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return { pair, publicKey: btoa(String.fromCharCode(...raw)) }
}

async function deriveRelayKey(keys: RelayKeys, remote: string) {
  if (!keys.pair || remote === 'plain') {
    if (keys.pair || remote !== 'plain') throw new Error('The devices could not agree on encryption.')
    return null
  }
  const raw = Uint8Array.from(atob(remote), (character) => character.charCodeAt(0))
  const publicKey = await crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  return crypto.subtle.deriveKey({ name: 'ECDH', public: publicKey }, keys.pair.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

// Frame layout: [kind: 0 text, 1 binary][12-byte IV][AES-GCM ciphertext].
async function seal(key: CryptoKey | null, kind: number, bytes: Uint8Array<ArrayBuffer>) {
  if (!key) {
    const frame = new Uint8Array(1 + bytes.length)
    frame[0] = kind
    frame.set(bytes, 1)
    return frame
  }
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes))
  const frame = new Uint8Array(13 + cipher.length)
  frame[0] = kind
  frame.set(iv, 1)
  frame.set(cipher, 13)
  return frame
}

async function unseal(key: CryptoKey | null, frame: Uint8Array) {
  const kind = frame[0]
  if (!key) return { kind, data: frame.slice(1).buffer }
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: frame.slice(1, 13) }, key, frame.slice(13))
  return { kind, data }
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

// The transfer protocol runs over a pipe, which is either the direct WebRTC
// data channel or the relay through the server.
interface Pipe {
  readonly open: boolean
  readonly bufferedAmount: number
  send(data: string | ArrayBuffer): void
  drained(): Promise<void>
  close(): void
}

class ChannelPipe implements Pipe {
  private readonly channel: RTCDataChannel

  constructor(channel: RTCDataChannel) {
    this.channel = channel
  }

  get open() {
    return this.channel.readyState === 'open'
  }

  get bufferedAmount() {
    return this.channel.bufferedAmount
  }

  send(data: string | ArrayBuffer) {
    if (typeof data === 'string') this.channel.send(data)
    else this.channel.send(data)
  }

  drained() {
    return new Promise<void>((resolve) => {
      if (!this.open || this.channel.bufferedAmount <= lowWater) return resolve()
      const done = () => {
        this.channel.removeEventListener('bufferedamountlow', done)
        this.channel.removeEventListener('close', done)
        resolve()
      }
      this.channel.addEventListener('bufferedamountlow', done)
      this.channel.addEventListener('close', done)
    })
  }

  close() {
    this.channel.close()
  }
}

class RelayPipe implements Pipe {
  open = true
  private pending = 0
  private sendChain = Promise.resolve()
  private receiveChain = Promise.resolve()
  private readonly peerId: string
  private readonly transport: RelayTransport
  private readonly key: CryptoKey | null
  private readonly onData: (data: string | ArrayBuffer) => void
  private readonly onFail: (reason: string) => void

  constructor(peerId: string, transport: RelayTransport, key: CryptoKey | null, onData: (data: string | ArrayBuffer) => void, onFail: (reason: string) => void) {
    this.peerId = peerId
    this.transport = transport
    this.key = key
    this.onData = onData
    this.onFail = onFail
  }

  get bufferedAmount() {
    return this.pending + this.transport.bufferedAmount()
  }

  send(data: string | ArrayBuffer) {
    if (!this.open) return
    const kind = typeof data === 'string' ? 0 : 1
    const bytes = typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data)
    this.pending += bytes.byteLength
    // Encryption is asynchronous; chaining keeps frames in the order they were sent.
    this.sendChain = this.sendChain.then(async () => {
      if (!this.open) return
      const frame = await seal(this.key, kind, bytes)
      this.pending -= bytes.byteLength
      if (!this.transport.send(this.peerId, frame)) this.fail('Lost the connection to the PexyDrop server.')
    }).catch(() => this.fail('Could not encrypt the data.'))
  }

  receive(frame: Uint8Array) {
    this.receiveChain = this.receiveChain.then(async () => {
      if (!this.open) return
      const { kind, data } = await unseal(this.key, frame)
      this.onData(kind === 0 ? decoder.decode(data) : data)
    }).catch(() => this.fail('Received data that could not be decrypted.'))
  }

  async drained() {
    while (this.open && this.bufferedAmount > lowWater) await delay(30)
  }

  private fail(reason: string) {
    if (!this.open) return
    this.open = false
    this.onFail(reason)
  }

  close() {
    this.open = false
  }
}

class Meter {
  private at = performance.now()
  private bytes = 0
  speed = 0

  sample(total: number) {
    const now = performance.now()
    const elapsed = now - this.at
    if (elapsed < 250) return false
    const rate = (total - this.bytes) / (elapsed / 1000)
    this.speed = this.speed ? this.speed * 0.6 + rate * 0.4 : rate
    this.at = now
    this.bytes = total
    return true
  }
}

type LinkOptions = {
  selfId: string
  peerId: string
  iceServers: RTCIceServer[]
  sendSignal: (data: Signal) => void
  relay: RelayTransport
  events: LinkEvents
  confirmRoute: ConfirmRoute
  onClose: () => void
}

export class PeerLink {
  readonly session = makeId()
  remoteSession: string | null = null
  route: Route | null = null
  closed = false

  private readonly peerId: string
  private readonly polite: boolean
  private readonly pc: RTCPeerConnection
  private readonly channel: RTCDataChannel
  private readonly opened: Promise<void>
  private readonly options: LinkOptions
  private readonly events: LinkEvents
  private mode: 'direct' | 'relay' = 'direct'
  private pipe: Pipe | null = null
  private heardFromRemote = false
  private relayKeys: Promise<RelayKeys> | null = null
  private relayKeySent = false
  private directTimer = 0
  private relayTimer = 0
  private localCandidates = new Set<string>()
  private remoteCandidates = new Set<string>()
  private makingOffer = false
  private ignoreOffer = false
  private signalQueue = Promise.resolve()
  private resolveOpen: () => void = () => {}
  private rejectOpen: (error: Error) => void = () => {}
  private wakeSender: (() => void) | null = null
  private sendQueue: File[][] = []
  private pumping = false
  private outgoing: Outgoing | null = null
  private incoming: Incoming | null = null
  private pendingOffer: IncomingOffer | null = null

  constructor(options: LinkOptions) {
    this.options = options
    this.events = options.events
    this.peerId = options.peerId
    this.polite = options.selfId > options.peerId
    this.opened = new Promise<void>((resolve, reject) => {
      this.resolveOpen = resolve
      this.rejectOpen = reject
    })
    this.opened.catch(() => {})

    this.pc = new RTCPeerConnection({ iceServers: options.iceServers })
    // A pre-negotiated channel lets either side start the connection without
    // waiting for the other to announce it.
    this.channel = this.pc.createDataChannel('pexydrop', { negotiated: true, id: 0, ordered: true })
    this.channel.binaryType = 'arraybuffer'
    this.channel.bufferedAmountLowThreshold = lowWater

    this.pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return
      if (candidate.type) this.localCandidates.add(candidate.type)
      this.signal({ candidate: candidate.toJSON() })
    }
    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true
        await this.pc.setLocalDescription()
        if (this.pc.localDescription) this.signal({ description: this.pc.localDescription.toJSON() })
      } catch (error) {
        console.warn('Could not create connection offer', error)
      } finally {
        this.makingOffer = false
      }
    }
    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === 'failed') this.directFailed('no network path between the devices')
    }
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState !== 'failed') return
      if (this.pipe) this.close('The connection to that device dropped.')
      else this.directFailed('the connection failed')
    }
    this.channel.onopen = async () => {
      if (this.mode !== 'direct' || this.closed) return
      window.clearTimeout(this.directTimer)
      this.pipe = new ChannelPipe(this.channel)
      this.route = await this.detectRoute()
      this.events.route(this.peerId, this.route)
      this.resolveOpen()
    }
    this.channel.onmessage = (event) => this.receive(event.data)
    this.channel.onclose = () => {
      if (this.mode === 'direct') this.close('That device disconnected.')
    }
    this.directTimer = window.setTimeout(() => this.directFailed('it took too long'), directTimeout)
  }

  get isDirectOpen() {
    return this.mode === 'direct' && Boolean(this.pipe?.open)
  }

  private signal(data: Omit<Signal, 'session'>) {
    this.options.sendSignal({ session: this.session, ...data })
  }

  // "Perfect negotiation": either side may start, and the polite side yields when
  // both send offers at the same moment.
  handleSignal(data: Signal) {
    this.heardFromRemote = true
    if (data.relayKey) {
      void this.acceptRelay(data.relayKey)
      return
    }
    if (this.mode === 'relay') return
    if (data.candidate?.candidate) {
      const type = / typ (\w+)/.exec(data.candidate.candidate)?.[1]
      if (type) this.remoteCandidates.add(type)
    }
    this.signalQueue = this.signalQueue.then(async () => {
      if (this.closed || this.mode === 'relay') return
      const { description, candidate } = data
      try {
        if (description) {
          const collision = description.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable')
          this.ignoreOffer = !this.polite && collision
          if (this.ignoreOffer) return
          await this.pc.setRemoteDescription(description)
          if (description.type === 'offer') {
            await this.pc.setLocalDescription()
            if (this.pc.localDescription) this.signal({ description: this.pc.localDescription.toJSON() })
          }
        } else if (candidate) {
          try {
            await this.pc.addIceCandidate(candidate)
          } catch (error) {
            if (!this.ignoreOffer) throw error
          }
        }
      } catch (error) {
        console.warn('Connection handshake failed', error)
      }
    })
  }

  private directFailed(reason: string) {
    if (this.closed || this.mode !== 'direct' || this.pipe) return
    window.clearTimeout(this.directTimer)
    // No reply at all means the other device is asleep or closed, and the relay
    // won't help either.
    if (!this.heardFromRemote) return this.fail(notResponding)
    console.info(`[PexyDrop] Direct connection failed (${reason}); using the relay.`, {
      localCandidates: [...this.localCandidates],
      remoteCandidates: [...this.remoteCandidates],
      iceState: this.pc.iceConnectionState,
    })
    this.enterRelayMode()
    this.relayTimer = window.setTimeout(() => this.fail(notResponding), relayTimeout)
    void this.sendRelayKey()
  }

  private enterRelayMode() {
    if (this.mode === 'relay') return
    this.mode = 'relay'
    window.clearTimeout(this.directTimer)
    this.pipe = null
    this.pc.onicecandidate = null
    this.pc.oniceconnectionstatechange = null
    this.pc.onconnectionstatechange = null
    this.channel.onopen = null
    this.channel.onmessage = null
    this.channel.onclose = null
    this.channel.close()
    this.pc.close()
  }

  private async sendRelayKey() {
    if (this.relayKeySent) return
    this.relayKeySent = true
    this.relayKeys ??= createRelayKeys()
    try {
      this.signal({ relayKey: (await this.relayKeys).publicKey })
    } catch {
      this.fail('Could not set up an encrypted connection.')
    }
  }

  private async acceptRelay(remoteKey: string) {
    if (this.closed || this.pipe instanceof RelayPipe) return
    this.enterRelayMode()
    void this.sendRelayKey()
    try {
      this.relayKeys ??= createRelayKeys()
      const key = await deriveRelayKey(await this.relayKeys, remoteKey)
      if (this.closed) return
      this.pipe = new RelayPipe(this.peerId, this.options.relay, key, (data) => this.receive(data), (reason) => this.close(reason))
      window.clearTimeout(this.relayTimer)
      this.route = 'relay'
      this.events.route(this.peerId, this.route)
      this.resolveOpen()
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Could not set up an encrypted connection.')
    }
  }

  receiveRelay(frame: Uint8Array) {
    if (this.pipe instanceof RelayPipe) this.pipe.receive(frame)
  }

  signalingLost() {
    if (this.mode === 'relay') this.close('Lost the connection to the PexyDrop server.')
  }

  // Works out whether the chosen path stays on the local network. The connection
  // type alone can't tell: a phone sharing its hotspot reports "cellular" even
  // though traffic to the laptop on that hotspot never touches mobile data.
  private async detectRoute(): Promise<Route> {
    try {
      const stats = await this.pc.getStats()
      let pair: RTCIceCandidatePairStats | undefined
      stats.forEach((report) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId)
      })
      if (!pair) {
        stats.forEach((report) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.selected || report.nominated)) pair = report
        })
      }
      if (!pair) return onCellular() ? 'internet' : 'local'
      const local = stats.get(pair.localCandidateId)
      const remote = stats.get(pair.remoteCandidateId)
      if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') return 'internet'
      if (local?.candidateType === 'host' && remote?.candidateType === 'host') return 'local'
      const remoteAddress: string = remote?.address ?? remote?.ip ?? ''
      // Devices behind the same router share one public address, so a match means
      // the traffic only loops through the router.
      const ownPublicAddresses = new Set<string>()
      stats.forEach((report) => {
        if (report.type === 'local-candidate' && report.candidateType === 'srflx') ownPublicAddresses.add(report.address ?? report.ip)
      })
      if (ownPublicAddresses.has(remoteAddress)) return 'local'
      if (!remoteAddress || remoteAddress.endsWith('.local') || isPrivateAddress(remoteAddress)) return onCellular() ? 'internet' : 'local'
      return 'internet'
    } catch {
      return onCellular() ? 'internet' : 'local'
    }
  }

  private control(message: Control) {
    if (this.pipe?.open) this.pipe.send(JSON.stringify(message))
  }

  private update(transfer: Transfer, patch: Partial<Transfer>) {
    Object.assign(transfer, patch)
    this.events.transfer({ ...transfer })
  }

  private awaitReply(state: Outgoing) {
    return new Promise<Control>((resolve, reject) => {
      state.resolve = resolve
      state.reject = reject
    })
  }

  // Waits for the send buffer to empty, or for a cancel.
  private drain(pipe: Pipe) {
    return new Promise<void>((resolve) => {
      const done = () => {
        this.wakeSender = null
        resolve()
      }
      this.wakeSender = done
      void pipe.drained().then(done)
    })
  }

  // Batches picked while another is still sending wait their turn.
  sendFiles(files: File[]) {
    if (!files.length || this.closed) return
    this.sendQueue.push(files)
    this.events.queued(this.peerId, this.pumping ? this.sendQueue.length : 0)
    if (!this.pumping) void this.pump()
  }

  private async pump() {
    this.pumping = true
    while (this.sendQueue.length && !this.closed) {
      const files = this.sendQueue.shift()!
      this.events.queued(this.peerId, this.sendQueue.length)
      await this.runSend(files)
    }
    this.pumping = false
  }

  private async runSend(files: File[]) {
    const meta = files.map((file) => ({ name: file.name, size: file.size, type: file.type }))
    const total = meta.reduce((sum, file) => sum + file.size, 0)
    const transfer: Transfer = { id: makeId(), peerId: this.peerId, direction: 'send', files: meta, total, transferred: 0, speed: 0, status: 'connecting' }
    const state: Outgoing = { transfer, cancelled: false }
    this.outgoing = state
    this.events.transfer({ ...transfer })
    try {
      await this.opened
      if (this.route && this.route !== 'local' && !(await this.options.confirmRoute(this.peerId, this.route, total))) {
        state.cancelled = true
      }
      if (state.cancelled) throw new Error('Cancelled')
      this.update(transfer, { status: 'waiting' })
      const reply = this.awaitReply(state)
      this.control({ t: 'offer', id: transfer.id, files: meta, total })
      const answer = await reply
      if (answer.t === 'decline') return this.update(transfer, { status: 'declined', error: answer.reason })
      if (answer.t !== 'accept') throw new Error('Cancelled')
      this.update(transfer, { status: 'sending' })
      await this.stream(state, files)
      const confirmation = this.awaitReply(state)
      this.control({ t: 'done', id: transfer.id })
      if ((await confirmation).t !== 'received') throw new Error('Cancelled')
      this.update(transfer, { status: 'done', transferred: total, speed: 0 })
    } catch (error) {
      if (state.cancelled) this.update(transfer, { status: 'cancelled', speed: 0 })
      else this.update(transfer, { status: 'failed', speed: 0, error: error instanceof Error ? error.message : 'The transfer failed.' })
    } finally {
      if (this.outgoing === state) this.outgoing = null
    }
  }

  private async stream(state: Outgoing, files: File[]) {
    const { transfer } = state
    const meter = new Meter()
    let sent = 0
    for (const [index, file] of files.entries()) {
      this.control({ t: 'file', id: transfer.id, index })
      for (let offset = 0; offset < file.size; offset += readSize) {
        const buffer = await file.slice(offset, offset + readSize).arrayBuffer()
        for (let position = 0; position < buffer.byteLength; position += chunkSize) {
          const pipe = this.pipe
          if (pipe && pipe.bufferedAmount > highWater) await this.drain(pipe)
          if (state.cancelled || this.closed || !this.pipe?.open) throw new Error(state.cancelled ? 'Cancelled' : 'The connection to that device dropped.')
          this.pipe.send(buffer.slice(position, position + chunkSize))
        }
        sent += buffer.byteLength
        if (meter.sample(sent)) this.update(transfer, { transferred: sent, speed: meter.speed })
      }
      this.control({ t: 'file-end', id: transfer.id, index })
    }
  }

  async sendText(text: string) {
    await this.opened
    this.control({ t: 'text', text })
  }

  // With a folder, files stream straight to disk instead of being held in memory.
  respond(offerId: string, accept: boolean, folder?: FileSystemDirectoryHandle) {
    const offer = this.pendingOffer
    if (!offer || offer.id !== offerId) return
    this.pendingOffer = null
    if (!accept) return this.control({ t: 'decline', id: offerId, reason: 'They declined the files.' })
    const transfer: Transfer = { id: offer.id, peerId: this.peerId, direction: 'receive', files: offer.files, total: offer.total, transferred: 0, speed: 0, status: 'receiving', toDisk: Boolean(folder) }
    this.incoming = { transfer, index: -1, chunks: [], meter: new Meter(), folder, chain: Promise.resolve(), failed: false }
    this.events.transfer({ ...transfer })
    this.control({ t: 'accept', id: offerId })
  }

  // Cancels the batch in progress and anything queued behind it.
  cancel(transferId: string) {
    if (this.outgoing?.transfer.id === transferId) {
      this.sendQueue = []
      this.events.queued(this.peerId, 0)
      this.outgoing.cancelled = true
      this.control({ t: 'cancel', id: transferId })
      this.outgoing.resolve?.({ t: 'cancel', id: transferId })
      this.wakeSender?.()
    }
    if (this.incoming?.transfer.id === transferId) {
      this.control({ t: 'cancel', id: transferId })
      this.abortIncoming('cancelled')
    }
  }

  private abortIncoming(status: 'cancelled' | 'failed', error?: string) {
    const incoming = this.incoming
    if (!incoming) return
    incoming.failed = true
    incoming.writer?.abort().catch(() => {})
    this.update(incoming.transfer, { status, speed: 0, error })
    this.incoming = null
  }

  private step(incoming: Incoming, task: () => Promise<void> | void) {
    incoming.chain = incoming.chain
      .then(() => (incoming.failed ? undefined : task()))
      .catch((error: Error) => {
        if (this.incoming !== incoming) return
        this.control({ t: 'cancel', id: incoming.transfer.id })
        this.abortIncoming('failed', `Couldn't save to the folder: ${error.message}`)
      })
  }

  private receive(data: string | ArrayBuffer) {
    if (typeof data !== 'string') {
      const incoming = this.incoming
      if (!incoming || incoming.index < 0) return
      if (incoming.folder) this.step(incoming, () => incoming.writer?.write(data))
      else incoming.chunks.push(data)
      incoming.transfer.transferred += data.byteLength
      if (incoming.meter.sample(incoming.transfer.transferred)) this.update(incoming.transfer, { speed: incoming.meter.speed })
      return
    }

    let message: Control
    try {
      message = JSON.parse(data)
    } catch {
      return
    }

    switch (message.t) {
      case 'offer': {
        const files = Array.isArray(message.files) ? message.files.slice(0, 2000).map((file) => ({
          name: String(file.name).replace(/[\\/]/g, '_').slice(0, 255) || 'file',
          size: Math.max(0, Number(file.size) || 0),
          type: String(file.type ?? '').slice(0, 120),
        })) : []
        if (!files.length) return
        if (this.incoming || this.pendingOffer) return this.control({ t: 'decline', id: message.id, reason: 'That device is busy with another transfer.' })
        this.pendingOffer = { id: String(message.id), peerId: this.peerId, files, total: files.reduce((sum, file) => sum + file.size, 0) }
        this.events.offer(this.pendingOffer)
        break
      }
      case 'accept':
      case 'decline':
      case 'received':
        if (this.outgoing?.transfer.id === message.id) this.outgoing.resolve?.(message)
        break
      case 'cancel':
        if (this.outgoing?.transfer.id === message.id) {
          this.sendQueue = []
          this.events.queued(this.peerId, 0)
          this.outgoing.cancelled = true
          this.outgoing.resolve?.(message)
          this.wakeSender?.()
        }
        if (this.pendingOffer?.id === message.id) {
          this.pendingOffer = null
          this.events.offerWithdrawn(message.id)
        }
        if (this.incoming?.transfer.id === message.id) this.abortIncoming('cancelled')
        break
      case 'file': {
        const incoming = this.incoming
        const meta = incoming?.transfer.files[message.index]
        if (!incoming || incoming.transfer.id !== message.id || !meta) break
        incoming.index = message.index
        incoming.chunks = []
        const folder = incoming.folder
        if (folder) {
          this.step(incoming, async () => {
            const created = await createUniqueFile(folder, meta.name)
            incoming.savedAs = created.name
            incoming.writer = await created.handle.createWritable()
          })
        }
        break
      }
      case 'file-end': {
        const incoming = this.incoming
        const meta = incoming?.transfer.files[message.index]
        if (!incoming || incoming.transfer.id !== message.id || !meta) break
        if (incoming.folder) {
          this.step(incoming, async () => {
            await incoming.writer?.close()
            incoming.writer = undefined
            this.events.saved(meta, incoming.savedAs ?? meta.name, this.peerId)
          })
        } else {
          this.events.file(new File(incoming.chunks, meta.name, { type: meta.type || 'application/octet-stream' }), this.peerId)
          incoming.chunks = []
        }
        incoming.index = -1
        break
      }
      case 'done': {
        const incoming = this.incoming
        if (!incoming || incoming.transfer.id !== message.id) break
        // Confirm only once everything has been written, so "Sent" means saved.
        this.step(incoming, () => {
          if (this.incoming !== incoming) return
          this.update(incoming.transfer, { status: 'done', transferred: incoming.transfer.total, speed: 0 })
          this.incoming = null
          this.control({ t: 'received', id: message.id })
        })
        break
      }
      case 'text':
        if (typeof message.text === 'string' && message.text) this.events.text(message.text.slice(0, 100_000), this.peerId)
        break
    }
  }

  private fail(reason: string) {
    this.rejectOpen(new Error(reason))
    this.close(reason)
  }

  close(reason: string) {
    if (this.closed) return
    this.closed = true
    window.clearTimeout(this.directTimer)
    window.clearTimeout(this.relayTimer)
    const error = new Error(reason)
    this.rejectOpen(error)
    this.sendQueue = []
    this.events.queued(this.peerId, 0)
    this.outgoing?.reject?.(error)
    this.wakeSender?.()
    this.abortIncoming('failed', reason)
    if (this.pendingOffer) this.events.offerWithdrawn(this.pendingOffer.id)
    this.pendingOffer = null
    this.events.route(this.peerId, null)
    this.pipe?.close()
    this.channel.close()
    this.pc.close()
    this.options.onClose()
  }
}

export class PeerManager {
  private readonly links = new Map<string, PeerLink>()
  private readonly missing = new Map<string, number>()
  private readonly sendSignal: (to: string, data: Signal) => void
  private readonly relay: RelayTransport
  private readonly events: LinkEvents
  private readonly confirmRoute: ConfirmRoute
  private iceServers = defaultIceServers
  private selfId = ''

  constructor(sendSignal: (to: string, data: Signal) => void, relay: RelayTransport, events: LinkEvents, confirmRoute: ConfirmRoute) {
    this.sendSignal = sendSignal
    this.relay = relay
    this.events = events
    this.confirmRoute = confirmRoute
  }

  setSelf(id: string, iceServers?: RTCIceServer[]) {
    if (this.selfId && this.selfId !== id) this.closeAll()
    this.selfId = id
    if (iceServers?.length) this.iceServers = iceServers
  }

  get(peerId: string) {
    const existing = this.links.get(peerId)
    if (existing && !existing.closed) return existing
    const link: PeerLink = new PeerLink({
      selfId: this.selfId,
      peerId,
      iceServers: this.iceServers,
      sendSignal: (data) => this.sendSignal(peerId, data),
      relay: this.relay,
      events: this.events,
      confirmRoute: this.confirmRoute,
      onClose: () => {
        if (this.links.get(peerId) === link) this.links.delete(peerId)
      },
    })
    this.links.set(peerId, link)
    return link
  }

  handleSignal(from: string, data: unknown) {
    if (!this.selfId || !data || typeof data !== 'object') return
    const signal = data as Signal
    if (typeof signal.session !== 'string') return
    let link = this.links.get(from)
    // A new session from the other side means it reloaded or rebuilt its
    // connection, so start over instead of mixing two handshakes.
    if (link && !link.closed && link.remoteSession && link.remoteSession !== signal.session) {
      if (signal.description?.type !== 'offer' && !signal.relayKey) return
      link.close('Reconnecting to that device.')
      link = undefined
    }
    link = link && !link.closed ? link : this.get(from)
    link.remoteSession ??= signal.session
    link.handleSignal(signal)
  }

  handleRelay(from: string, frame: Uint8Array) {
    this.links.get(from)?.receiveRelay(frame)
  }

  signalingLost() {
    for (const link of this.links.values()) link.signalingLost()
  }

  // A device can vanish from the list for a moment while its phone reconnects.
  // Give it time to come back, and never cut a direct connection that still works.
  sync(peerIds: Set<string>) {
    for (const [peerId, timer] of this.missing) {
      if (!peerIds.has(peerId)) continue
      window.clearTimeout(timer)
      this.missing.delete(peerId)
    }
    for (const [peerId, link] of this.links) {
      if (peerIds.has(peerId) || this.missing.has(peerId)) continue
      this.missing.set(peerId, window.setTimeout(() => {
        this.missing.delete(peerId)
        const current = this.links.get(peerId)
        if (current === link && !link.isDirectOpen) link.close('That device went offline.')
      }, 12_000))
    }
  }

  closeAll() {
    for (const timer of this.missing.values()) window.clearTimeout(timer)
    this.missing.clear()
    for (const link of this.links.values()) link.close('Disconnected.')
    this.links.clear()
  }
}
