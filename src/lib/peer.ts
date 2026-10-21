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

// Asks the person whether a transfer may go over the internet (and so possibly
// mobile data). Resolves true to go ahead.
export type ConfirmInternet = (peerId: string, bytes: number) => Promise<boolean>

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
const connectTimeout = 20_000
const defaultIceServers: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]

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
  events: LinkEvents
  askBeforeInternet: () => boolean
  confirmInternet: ConfirmInternet
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
  private makingOffer = false
  private ignoreOffer = false
  private signalQueue = Promise.resolve()
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
    this.pc = new RTCPeerConnection({ iceServers: options.iceServers })
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
        const error = new Error('Could not reach that device. Put both devices on the same Wi-Fi, or connect one to the other\'s hotspot, and keep PexyDrop open on both.')
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
    this.options.sendSignal({ session: this.session, ...data })
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
      if (this.route === 'internet' && this.options.askBeforeInternet() && !(await this.options.confirmInternet(this.peerId, total))) {
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

  close(reason: string) {
    if (this.closed) return
    this.closed = true
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
    this.channel.close()
    this.pc.close()
    this.options.onClose()
  }
}

export class PeerManager {
  private readonly links = new Map<string, PeerLink>()
  private readonly sendSignal: (to: string, data: Signal) => void
  private readonly events: LinkEvents
  private readonly askBeforeInternet: () => boolean
  private readonly confirmInternet: ConfirmInternet
  private iceServers = defaultIceServers
  private selfId = ''

  constructor(sendSignal: (to: string, data: Signal) => void, events: LinkEvents, askBeforeInternet: () => boolean, confirmInternet: ConfirmInternet) {
    this.sendSignal = sendSignal
    this.events = events
    this.askBeforeInternet = askBeforeInternet
    this.confirmInternet = confirmInternet
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
      events: this.events,
      askBeforeInternet: this.askBeforeInternet,
      confirmInternet: this.confirmInternet,
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
