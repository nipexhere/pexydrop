import type { DeviceKind } from './identity'

export type RemotePeer = {
  id: string
  name: string
  device: DeviceKind
  detail: string
  via: 'network' | 'code'
}

export type ServerMessage =
  | { type: 'welcome'; id: string }
  | { type: 'peers'; peers: RemotePeer[] }
  | { type: 'room'; code: string | null }
  | { type: 'room-error'; error: string }
  | { type: 'signal'; from: string; data: unknown }

type Hello = { name: string; device: DeviceKind; detail: string; secret: string }

export class Signaling {
  private socket: WebSocket | null = null
  private retryDelay = 1000
  private retryTimer = 0
  private stopped = false
  private readonly hello: () => Hello
  private readonly onMessage: (message: ServerMessage) => void
  private readonly onStatus: (online: boolean) => void

  constructor(hello: () => Hello, onMessage: (message: ServerMessage) => void, onStatus: (online: boolean) => void) {
    this.hello = hello
    this.onMessage = onMessage
    this.onStatus = onStatus
    document.addEventListener('visibilitychange', this.wake)
    window.addEventListener('online', this.wake)
    this.connect()
  }

  // Phones suspend background tabs, so reconnect right away when the page comes back.
  private wake = () => {
    if (document.visibilityState !== 'visible' || this.stopped) return
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      window.clearTimeout(this.retryTimer)
      this.retryDelay = 1000
      this.connect()
    }
  }

  private connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${location.host}/ws`)
    this.socket = socket
    socket.onopen = () => {
      this.retryDelay = 1000
      socket.send(JSON.stringify({ type: 'hello', ...this.hello() }))
    }
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as ServerMessage
      if (message.type === 'welcome') this.onStatus(true)
      this.onMessage(message)
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.onStatus(false)
      if (this.stopped) return
      this.retryTimer = window.setTimeout(() => this.connect(), this.retryDelay)
      this.retryDelay = Math.min(this.retryDelay * 2, 10_000)
    }
  }

  send(message: Record<string, unknown>) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  close() {
    this.stopped = true
    window.clearTimeout(this.retryTimer)
    document.removeEventListener('visibilitychange', this.wake)
    window.removeEventListener('online', this.wake)
    this.socket?.close()
  }
}
