export type FileMeta = { name: string; size: number; type: string }
export type Route = 'local' | 'internet'
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
  error?: string
}

export type IncomingOffer = { id: string; peerId: string; files: FileMeta[]; total: number }

export type LinkEvents = {
  transfer: (transfer: Transfer) => void
  offer: (offer: IncomingOffer) => void
  offerWithdrawn: (offerId: string) => void
  file: (file: File, peerId: string) => void
  text: (text: string, peerId: string) => void
  route: (peerId: string, route: Route | null) => void
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

type Signal = { session: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }

type Outgoing = {
  transfer: Transfer
  cancelled: boolean
  resolve?: (reply: Control) => void
  reject?: (error: Error) => void
}

type Incoming = { transfer: Transfer; index: number; chunks: ArrayBuffer[]; meter: Meter }

// 64 KiB messages are the largest size every browser's data channel accepts.
const chunkSize = 64 * 1024
const readSize = 1024 * 1024
const highWater = 8 * 1024 * 1024
const lowWater = 1024 * 1024
const connectTimeout = 20_000
// STUN only reveals each device's public address so peers can find a path. No
// relay (TURN) is configured, so file data can only travel device to device.
const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]

export const wifiOnlyMessage = 'That device is not on your Wi-Fi. Join the same network, or turn off Wi-Fi only to send over the internet.'

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
  private readonly sendSignal: (data: Signal) => void
  private readonly events: LinkEvents
  private readonly wifiOnly: () => boolean
  private readonly onClose: () => void
  private makingOffer = false
  private ignoreOffer = false
  private signalQueue = Promise.resolve()
  private rejectOpen: (error: Error) => void = () => {}
  private wakeSender: (() => void) | null = null
  private outgoing: Outgoing | null = null
  private incoming: Incoming | null = null
  private pendingOffer: IncomingOffer | null = null

  constructor(selfId: string, peerId: string, sendSignal: (data: Signal) => void, events: LinkEvents, wifiOnly: () => boolean, onClose: () => void) {
    this.peerId = peerId
    this.polite = selfId > peerId
    this.sendSignal = sendSignal
    this.events = events
    this.wifiOnly = wifiOnly
    this.onClose = onClose
    this.pc = new RTCPeerConnection({ iceServers })
    // A pre-negotiated channel lets either side start the connection without
    // waiting for the other to announce it.
    this.channel = this.pc.createDataChannel('pexydrop', { negotiated: true, id: 0, ordered: true })
    this.channel.binaryType = 'arraybuffer'
    this.channel.bufferedAmountLowThreshold = lowWater

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.signal({ candidate: candidate.toJSON() })
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
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'failed') this.close('The connection to that device dropped.')
    }

    this.opened = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const error = new Error('Could not reach that device. Make sure both devices are on the same Wi-Fi and the page is open.')
        reject(error)
        this.close(error.message)
      }, connectTimeout)
      this.rejectOpen = (error) => {
        window.clearTimeout(timer)
        reject(error)
      }
      this.channel.onopen = async () => {
        window.clearTimeout(timer)
        this.route = await this.detectRoute()
        this.events.route(this.peerId, this.route)
        resolve()
      }
    })
    this.opened.catch(() => {})
    this.channel.onmessage = (event) => this.receive(event.data)
    this.channel.onclose = () => this.close('That device disconnected.')
  }

  private signal(data: Omit<Signal, 'session'>) {
    this.sendSignal({ session: this.session, ...data })
  }

  // "Perfect negotiation": either side may start, and the polite side yields when
  // both send offers at the same moment.
  handleSignal(data: Signal) {
    this.signalQueue = this.signalQueue.then(async () => {
      if (this.closed) return
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

  private async detectRoute(): Promise<Route> {
    if (onCellular()) return 'internet'
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
      if (!pair) return 'local'
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
      if (!remoteAddress || remoteAddress.endsWith('.local') || isPrivateAddress(remoteAddress) || ownPublicAddresses.has(remoteAddress)) return 'local'
      return 'internet'
    } catch {
      return 'local'
    }
  }

  private async ready() {
    await this.opened
    if (this.wifiOnly() && this.route === 'internet') throw new Error(wifiOnlyMessage)
  }

  private control(message: Control) {
    if (this.channel.readyState === 'open') this.channel.send(JSON.stringify(message))
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

  private drain() {
    return new Promise<void>((resolve) => {
      const done = () => {
        this.channel.removeEventListener('bufferedamountlow', done)
        this.wakeSender = null
        resolve()
      }
      this.wakeSender = done
      this.channel.addEventListener('bufferedamountlow', done)
    })
  }

  async sendFiles(files: File[]) {
    if (this.outgoing) throw new Error('Already sending to this device. Wait for it to finish.')
    const meta = files.map((file) => ({ name: file.name, size: file.size, type: file.type }))
    const total = meta.reduce((sum, file) => sum + file.size, 0)
    const transfer: Transfer = { id: makeId(), peerId: this.peerId, direction: 'send', files: meta, total, transferred: 0, speed: 0, status: 'connecting' }
    const state: Outgoing = { transfer, cancelled: false }
    this.outgoing = state
    this.events.transfer({ ...transfer })
    try {
      await this.ready()
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
          if (this.channel.bufferedAmount > highWater) await this.drain()
          if (state.cancelled || this.closed) throw new Error('Cancelled')
          this.channel.send(buffer.slice(position, position + chunkSize))
        }
        sent += buffer.byteLength
        if (meter.sample(sent)) this.update(transfer, { transferred: sent, speed: meter.speed })
      }
      this.control({ t: 'file-end', id: transfer.id, index })
    }
  }

  async sendText(text: string) {
    await this.ready()
    this.control({ t: 'text', text })
  }

  respond(offerId: string, accept: boolean) {
    const offer = this.pendingOffer
    if (!offer || offer.id !== offerId) return
    this.pendingOffer = null
    if (!accept) return this.control({ t: 'decline', id: offerId, reason: 'They declined the files.' })
    const transfer: Transfer = { id: offer.id, peerId: this.peerId, direction: 'receive', files: offer.files, total: offer.total, transferred: 0, speed: 0, status: 'receiving' }
    this.incoming = { transfer, index: -1, chunks: [], meter: new Meter() }
    this.events.transfer({ ...transfer })
    this.control({ t: 'accept', id: offerId })
  }

  cancel(transferId: string) {
    if (this.outgoing?.transfer.id === transferId) {
      this.outgoing.cancelled = true
      this.control({ t: 'cancel', id: transferId })
      this.outgoing.resolve?.({ t: 'cancel', id: transferId })
      this.wakeSender?.()
    }
    if (this.incoming?.transfer.id === transferId) {
      this.control({ t: 'cancel', id: transferId })
      this.update(this.incoming.transfer, { status: 'cancelled', speed: 0 })
      this.incoming = null
    }
  }

  private receive(data: string | ArrayBuffer) {
    if (typeof data !== 'string') {
      const incoming = this.incoming
      if (!incoming || incoming.index < 0) return
      incoming.chunks.push(data)
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
        if (this.wifiOnly() && this.route === 'internet') return this.control({ t: 'decline', id: message.id, reason: 'That device only accepts files over Wi-Fi.' })
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
          this.outgoing.cancelled = true
          this.outgoing.resolve?.(message)
          this.wakeSender?.()
        }
        if (this.pendingOffer?.id === message.id) {
          this.pendingOffer = null
          this.events.offerWithdrawn(message.id)
        }
        if (this.incoming?.transfer.id === message.id) {
          this.update(this.incoming.transfer, { status: 'cancelled', speed: 0 })
          this.incoming = null
        }
        break
      case 'file':
        if (this.incoming?.transfer.id === message.id) {
          this.incoming.index = message.index
          this.incoming.chunks = []
        }
        break
      case 'file-end': {
        const incoming = this.incoming
        const meta = incoming?.transfer.files[message.index]
        if (!incoming || incoming.transfer.id !== message.id || !meta) break
        this.events.file(new File(incoming.chunks, meta.name, { type: meta.type || 'application/octet-stream' }), this.peerId)
        incoming.chunks = []
        incoming.index = -1
        break
      }
      case 'done':
        if (this.incoming?.transfer.id === message.id) {
          this.update(this.incoming.transfer, { status: 'done', transferred: this.incoming.transfer.total, speed: 0 })
          this.incoming = null
          this.control({ t: 'received', id: message.id })
        }
        break
      case 'text':
        if (typeof message.text === 'string' && message.text) this.events.text(message.text.slice(0, 100_000), this.peerId)
        break
    }
  }

  close(reason: string) {
    if (this.closed) return
    this.closed = true
    const error = new Error(reason)
    this.rejectOpen(error)
    this.outgoing?.reject?.(error)
    this.wakeSender?.()
    if (this.incoming) this.update(this.incoming.transfer, { status: 'failed', speed: 0, error: reason })
    this.incoming = null
    if (this.pendingOffer) this.events.offerWithdrawn(this.pendingOffer.id)
    this.pendingOffer = null
    this.events.route(this.peerId, null)
    this.channel.close()
    this.pc.close()
    this.onClose()
  }
}

export class PeerManager {
  private readonly links = new Map<string, PeerLink>()
  private readonly sendSignal: (to: string, data: Signal) => void
  private readonly events: LinkEvents
  private readonly wifiOnly: () => boolean
  private selfId = ''

  constructor(sendSignal: (to: string, data: Signal) => void, events: LinkEvents, wifiOnly: () => boolean) {
    this.sendSignal = sendSignal
    this.events = events
    this.wifiOnly = wifiOnly
  }

  setSelf(id: string) {
    if (this.selfId && this.selfId !== id) this.closeAll()
    this.selfId = id
  }

  get(peerId: string) {
    const existing = this.links.get(peerId)
    if (existing && !existing.closed) return existing
    const link: PeerLink = new PeerLink(this.selfId, peerId, (data) => this.sendSignal(peerId, data), this.events, this.wifiOnly, () => {
      if (this.links.get(peerId) === link) this.links.delete(peerId)
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
      if (signal.description?.type !== 'offer') return
      link.close('Reconnecting to that device.')
      link = undefined
    }
    link = link && !link.closed ? link : this.get(from)
    link.remoteSession ??= signal.session
    link.handleSignal(signal)
  }

  sync(peerIds: Set<string>) {
    for (const [peerId, link] of this.links) {
      if (!peerIds.has(peerId)) link.close('That device went offline.')
    }
  }

  closeAll() {
    for (const link of this.links.values()) link.close('Disconnected.')
    this.links.clear()
  }
}
