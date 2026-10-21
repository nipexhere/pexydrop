import type { DeviceKind } from './identity'

export type RemotePeer = {
  id: string
  name: string
  device: DeviceKind
  detail: string
  cellular?: boolean
  via: 'network' | 'code'
}

export type ServerMessage =
  | { type: 'welcome'; id: string; iceServers?: RTCIceServer[] }
  | { type: 'peers'; peers: RemotePeer[] }
  | { type: 'room'; code: string | null }
  | { type: 'room-error'; error: string }
  | { type: 'signal'; from: string; data: unknown }

type Hello = { name: string; device: DeviceKind; detail: string; secret: string; cellular: boolean }

// Peer ids are always 12 characters, which lets relay frames carry one as a
// fixed-size prefix.
const idLength = 12
const outboxLimit = 500

export class Signaling {
  private socket: WebSocket | null = null
  private welcomed = false
  private outbox: Record<string, unknown>[] = []
  private retryDelay = 1000
  private retryTimer = 0
  private stopped = false
  private readonly hello: () => Hello
  private readonly onMessage: (message: ServerMessage) => void
  private readonly onBinary: (from: string, payload: Uint8Array) => void
  private readonly onStatus: (online: boolean) => void

  constructor(
    hello: () => Hello,
    onMessage: (message: ServerMessage) => void,
    onBinary: (from: string, payload: Uint8Array) => void,
    onStatus: (online: boolean) => void,
  ) {
    this.hello = hello
    this.onMessage = onMessage
    this.onBinary = onBinary
    this.onStatus = onStatus
    document.addEventListener('visibilitychange', this.wake)
    window.addEventListener('online', this.wake)
    window.addEventListener('pageshow', this.wake)
    this.connect()
  }

  get online() {
    return this.welcomed && this.socket?.readyState === WebSocket.OPEN
  }

  get bufferedAmount() {
    return this.socket?.bufferedAmount ?? 0
  }

  // Phones suspend background tabs, so reconnect right away when the page comes back.
  private wake = () => {
    if (document.visibilityState !== 'visible' || this.stopped) return
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED || this.socket.readyState === WebSocket.CLOSING) {
      window.clearTimeout(this.retryTimer)
      this.retryDelay = 1000
      this.connect()
    }
  }

  private connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${location.host}/ws`)
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    this.welcomed = false
    socket.onopen = () => {
      this.retryDelay = 1000
      socket.send(JSON.stringify({ type: 'hello', ...this.hello() }))
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        const frame = new Uint8Array(event.data as ArrayBuffer)
        if (frame.length > idLength) this.onBinary(String.fromCharCode(...frame.subarray(0, idLength)), frame.subarray(idLength))
        return
      }
      const message = JSON.parse(event.data) as ServerMessage
      if (message.type === 'welcome') {
        this.welcomed = true
        this.onStatus(true)
        this.onMessage(message)
        // Messages sent while reconnecting are delivered now. Dropping them would
        // leave a connection attempt stuck halfway through its handshake.
        const pending = this.outbox
        this.outbox = []
        for (const queued of pending) socket.send(JSON.stringify(queued))
        return
      }
      this.onMessage(message)
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.welcomed = false
      this.onStatus(false)
      if (this.stopped) return
      this.retryTimer = window.setTimeout(() => this.connect(), this.retryDelay)
      this.retryDelay = Math.min(this.retryDelay * 2, 10_000)
    }
  }

  send(message: Record<string, unknown>) {
    if (this.online) {
      this.socket!.send(JSON.stringify(message))
      return
    }
    // Room and status messages are re-sent after reconnecting anyway; only
    // handshake signals need to survive the gap.
    if (message.type !== 'signal') return
    this.outbox.push(message)
    if (this.outbox.length > outboxLimit) this.outbox.shift()
  }

  // Relayed data is never queued: a gap would corrupt the transfer, so the
  // caller fails the transfer instead.
  sendBinary(to: string, payload: Uint8Array) {
    if (!this.online || to.length !== idLength) return false
    const frame = new Uint8Array(idLength + payload.length)
    for (let index = 0; index < idLength; index += 1) frame[index] = to.charCodeAt(index)
    frame.set(payload, idLength)
    this.socket!.send(frame)
    return true
  }

  close() {
    this.stopped = true
    window.clearTimeout(this.retryTimer)
    document.removeEventListener('visibilitychange', this.wake)
    window.removeEventListener('online', this.wake)
    window.removeEventListener('pageshow', this.wake)
    this.socket?.close()
  }
}
