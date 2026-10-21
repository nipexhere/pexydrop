import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react'
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  Copy,
  Download,
  ExternalLink,
  File as FileGlyph,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  FolderOpen,
  Globe,
  History,
  Laptop,
  Link2,
  LogOut,
  MessageSquareText,
  Pencil,
  Send,
  Server,
  Share2,
  ShieldCheck,
  Signal as SignalIcon,
  Smartphone,
  Tablet,
  Trash2,
  TriangleAlert,
  Upload,
  Wifi,
  X,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { describeDevice, detectDevice, loadDeviceName, saveDeviceName, type DeviceKind } from './lib/identity'
import { makeId, onCellular, PeerManager, type IncomingOffer, type Route, type Transfer } from './lib/peer'
import { Signaling, type RemotePeer } from './lib/signaling'
import { canSaveToFolder, folderReady, forgetSaveFolder, loadHistory, loadSaveFolder, pickSaveFolder, saveHistory, type HistoryEntry } from './lib/storage'

type Received =
  | { id: string; kind: 'file'; file: File; url: string; from: string; at: number }
  | { id: string; kind: 'saved'; name: string; size: number; folder: string; from: string; at: number }
  | { id: string; kind: 'text'; text: string; from: string; at: number }

type Staged = { files: File[]; text: string }
type DataPrompt = { peerId: string; route: Route; bytes: number; resolve: (send: boolean) => void }

const roomStorage = 'pexydrop-room'
const secretStorage = 'pexydrop-secret'
const askDataStorage = 'pexydrop-wifi-only'
const autoSaveStorage = 'pexydrop-auto-save'
const shareCache = 'pexydrop-share'
const terminal = new Set(['done', 'declined', 'cancelled', 'failed'])
const thisDevice = detectDevice()
const isComputer = thisDevice === 'laptop' || thisDevice === 'desktop'

function storageGet(storage: () => Storage, key: string) {
  try {
    return storage().getItem(key)
  } catch {
    return null
  }
}

function storageSet(storage: () => Storage, key: string, value: string | null) {
  try {
    if (value === null) storage().removeItem(key)
    else storage().setItem(key, value)
  } catch {
    // Storage can be unavailable in private browsing; settings then last for this visit.
  }
}

// Per tab, so two tabs on one laptop appear as two devices.
function tabSecret() {
  const saved = storageGet(() => sessionStorage, secretStorage)
  if (saved) return saved
  const secret = makeId() + makeId()
  storageSet(() => sessionStorage, secretStorage, secret)
  return secret
}

function takeUrlParam(name: string) {
  const url = new URL(location.href)
  const value = url.searchParams.get(name)
  if (value === null) return null
  url.searchParams.delete(name)
  history.replaceState(null, '', url.pathname + url.search + url.hash)
  return value
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = bytes / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unit]}`
}

function formatWhen(at: number) {
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const date = new Date(at)
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function fileIcon(type: string) {
  if (type.startsWith('image/')) return FileImage
  if (type.startsWith('video/')) return FileVideo
  if (type.startsWith('audio/')) return FileAudio
  if (type.includes('zip') || type.includes('compressed')) return FileArchive
  if (type.includes('text') || type.includes('pdf')) return FileText
  return FileGlyph
}

function deviceIcon(device: DeviceKind) {
  if (device === 'phone') return Smartphone
  if (device === 'tablet') return Tablet
  return Laptop
}

function formatCode(code: string) {
  return `${code.slice(0, 3)} ${code.slice(3)}`
}

function isLink(text: string) {
  return /^https?:\/\/\S+$/i.test(text.trim())
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function download(url: string, name: string) {
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
}

function describeTransfer(transfer: Transfer) {
  const percent = transfer.total ? Math.min(100, Math.round((transfer.transferred / transfer.total) * 100)) : 0
  const speed = transfer.speed > 0 ? ` · ${formatBytes(transfer.speed)}/s` : ''
  switch (transfer.status) {
    case 'connecting': return 'Connecting…'
    case 'waiting': return 'Waiting for them to accept'
    case 'sending': return `Sending ${percent}%${speed}`
    case 'receiving': return `Receiving ${percent}%${speed}`
    case 'done': return transfer.direction === 'send' ? `Sent ${plural(transfer.files.length, 'file')}` : `Received ${plural(transfer.files.length, 'file')}`
    case 'declined': return 'Declined'
    case 'cancelled': return 'Cancelled'
    case 'failed': return 'Transfer failed'
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // The async clipboard needs HTTPS; fall back for plain-HTTP local hosting.
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  }
}

function ProgressRing({ value }: { value: number }) {
  const radius = 33
  const circumference = 2 * Math.PI * radius
  return (
    <svg className="progress-ring" viewBox="0 0 72 72" aria-hidden="true">
      <circle cx="36" cy="36" r={radius} />
      <circle cx="36" cy="36" r={radius} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - value)} />
    </svg>
  )
}

function Toggle({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="toggle-row">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="toggle" aria-hidden="true" />
    </label>
  )
}

export default function App() {
  const [name, setName] = useState(loadDeviceName)
  const [nameDraft, setNameDraft] = useState(name)
  const [editingName, setEditingName] = useState(false)
  const [askBeforeData, setAskBeforeData] = useState(() => storageGet(() => localStorage, askDataStorage) !== 'false')
  const [autoSave, setAutoSave] = useState(() => {
    const saved = storageGet(() => localStorage, autoSaveStorage)
    return saved === null ? isComputer : saved === 'true'
  })
  const [folder, setFolder] = useState<FileSystemDirectoryHandle | null>(null)
  const [online, setOnline] = useState(false)
  const [peers, setPeers] = useState<RemotePeer[]>([])
  const [routes, setRoutes] = useState<Record<string, Route>>({})
  const [transfers, setTransfers] = useState<Record<string, Transfer>>({})
  const [queued, setQueued] = useState<Record<string, number>>({})
  const [offers, setOffers] = useState<IncomingOffer[]>([])
  const [trustOffer, setTrustOffer] = useState(false)
  const [trusted, setTrusted] = useState<string[]>([])
  const [dataPrompt, setDataPrompt] = useState<DataPrompt | null>(null)
  const [received, setReceived] = useState<Received[]>([])
  const [recent, setRecent] = useState<HistoryEntry[]>(loadHistory)
  const [shownText, setShownText] = useState<Extract<Received, { kind: 'text' }> | null>(null)
  const [room, setRoom] = useState<string | null>(null)
  const [roomInput, setRoomInput] = useState('')
  const [roomError, setRoomError] = useState('')
  const [addresses, setAddresses] = useState<string[]>([])
  const [staged, setStaged] = useState<Staged | null>(null)
  const [composeFor, setComposeFor] = useState<RemotePeer | null>(null)
  const [draft, setDraft] = useState('')
  const [dragTarget, setDragTarget] = useState<string | null>(null)
  const [pageDrag, setPageDrag] = useState(false)
  const [toast, setToast] = useState('')
  const [cellular, setCellular] = useState(onCellular)
  const [cellularDismissed, setCellularDismissed] = useState(false)
  const [copiedId, setCopiedId] = useState('')

  const nameRef = useRef(name)
  const askBeforeDataRef = useRef(askBeforeData)
  const autoSaveRef = useRef(autoSave)
  const folderRef = useRef(folder)
  const trustedRef = useRef(trusted)
  const peersRef = useRef<RemotePeer[]>([])
  const joinSourceRef = useRef<'url' | 'saved' | 'manual' | null>(null)
  const signalingRef = useRef<Signaling | null>(null)
  const managerRef = useRef<PeerManager | null>(null)
  const pickTargetRef = useRef<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  nameRef.current = name
  askBeforeDataRef.current = askBeforeData
  autoSaveRef.current = autoSave
  folderRef.current = folder
  trustedRef.current = trusted

  useEffect(() => {
    const peerName = (peerId: string) => peersRef.current.find((peer) => peer.id === peerId)?.name ?? 'A nearby device'

    const manager = new PeerManager(
      (to, data) => signalingRef.current?.send({ type: 'signal', to, data }),
      {
        send: (to, payload) => signalingRef.current?.sendBinary(to, payload) ?? false,
        bufferedAmount: () => signalingRef.current?.bufferedAmount ?? 0,
      },
      {
        transfer: (transfer) => {
          setTransfers((current) => ({ ...current, [transfer.peerId]: transfer }))
          if (transfer.status === 'failed' && transfer.error) setToast(transfer.error)
          if (transfer.status === 'declined') setToast(transfer.error || 'They declined the files.')
          if (transfer.status === 'done') {
            const entry: HistoryEntry = {
              id: transfer.id,
              direction: transfer.direction,
              peer: peerName(transfer.peerId),
              names: transfer.files.slice(0, 3).map((file) => file.name),
              count: transfer.files.length,
              total: transfer.total,
              at: Date.now(),
            }
            setRecent((current) => saveHistory([entry, ...current.filter((item) => item.id !== entry.id)]))
          }
          if (terminal.has(transfer.status)) {
            window.setTimeout(() => setTransfers((current) => {
              const latest = current[transfer.peerId]
              if (latest?.id !== transfer.id || latest.status !== transfer.status) return current
              const next = { ...current }
              delete next[transfer.peerId]
              return next
            }), 6000)
          }
        },
        queued: (peerId, count) => setQueued((current) => ({ ...current, [peerId]: count })),
        offer: (offer) => {
          if (trustedRef.current.includes(offer.peerId)) {
            void (async () => {
              const saveFolder = folderRef.current
              const useFolder = saveFolder && (await folderReady(saveFolder, false))
              manager.get(offer.peerId).respond(offer.id, true, useFolder ? saveFolder : undefined)
            })()
            return
          }
          setOffers((current) => [...current, offer])
          navigator.vibrate?.(120)
        },
        offerWithdrawn: (offerId) => setOffers((current) => current.filter((offer) => offer.id !== offerId)),
        file: (file, peerId) => {
          const url = URL.createObjectURL(file)
          setReceived((current) => [{ id: makeId(), kind: 'file', file, url, from: peerName(peerId), at: Date.now() }, ...current])
          if (autoSaveRef.current) download(url, file.name)
        },
        saved: (meta, savedAs, peerId) => {
          const folderName = folderRef.current?.name || 'your folder'
          setReceived((current) => [{ id: makeId(), kind: 'saved', name: savedAs, size: meta.size, folder: folderName, from: peerName(peerId), at: Date.now() }, ...current])
        },
        text: (text, peerId) => {
          const item = { id: makeId(), kind: 'text' as const, text, from: peerName(peerId), at: Date.now() }
          setReceived((current) => [item, ...current])
          setShownText(item)
          navigator.vibrate?.(80)
        },
        route: (peerId, route) => setRoutes((current) => {
          const next = { ...current }
          if (route) next[peerId] = route
          else delete next[peerId]
          return next
        }),
      },
      (peerId, route, bytes) => {
        if (!askBeforeDataRef.current) return Promise.resolve(true)
        // Relaying between two devices on the same Wi-Fi uses that Wi-Fi's internet
        // connection, not mobile data, so there is nothing to ask about.
        const peer = peersRef.current.find((item) => item.id === peerId)
        if (route === 'relay' && peer?.via === 'network' && !peer.cellular && !onCellular()) return Promise.resolve(true)
        return new Promise<boolean>((resolve) => setDataPrompt({ peerId, route, bytes, resolve }))
      },
    )
    managerRef.current = manager

    const signaling = new Signaling(
      () => ({ name: nameRef.current, device: thisDevice, detail: describeDevice(), secret: tabSecret(), cellular: onCellular() }),
      (message) => {
        switch (message.type) {
          case 'welcome': {
            manager.setSelf(message.id, message.iceServers)
            const fromUrl = takeUrlParam('room')
            const saved = storageGet(() => sessionStorage, roomStorage)
            if (fromUrl) {
              joinSourceRef.current = 'url'
              signaling.send({ type: 'join-room', code: fromUrl })
            } else if (saved) {
              joinSourceRef.current = 'saved'
              signaling.send({ type: 'join-room', code: saved })
            } else if (thisDevice !== 'phone') {
              // Computers show a pairing QR right away so a phone can scan it.
              signaling.send({ type: 'create-room' })
            }
            break
          }
          case 'peers':
            peersRef.current = message.peers
            setPeers(message.peers)
            manager.sync(new Set(message.peers.map((peer) => peer.id)))
            break
          case 'room':
            joinSourceRef.current = null
            setRoom(message.code)
            setRoomError('')
            storageSet(() => sessionStorage, roomStorage, message.code)
            if (message.code) setRoomInput('')
            break
          case 'room-error':
            if (joinSourceRef.current === 'saved') {
              storageSet(() => sessionStorage, roomStorage, null)
              if (thisDevice !== 'phone') signaling.send({ type: 'create-room' })
            } else {
              setRoomError(message.error)
            }
            joinSourceRef.current = null
            break
          case 'signal':
            manager.handleSignal(message.from, message.data)
            break
        }
      },
      (from, frame) => manager.handleRelay(from, frame),
      (isOnline) => {
        setOnline(isOnline)
        if (!isOnline) manager.signalingLost()
      },
    )
    signalingRef.current = signaling

    return () => {
      signaling.close()
      manager.closeAll()
    }
  }, [])

  useEffect(() => {
    fetch('/api/info').then((response) => response.json()).then((info: { addresses: string[] }) => setAddresses(info.addresses)).catch(() => {})
    void loadSaveFolder().then(setFolder)
  }, [])

  // Files shared into the installed app from another app's share sheet (Android).
  useEffect(() => {
    if (takeUrlParam('shared') === null || !('caches' in window)) return
    void (async () => {
      const cache = await caches.open(shareCache)
      const files: File[] = []
      let text = ''
      for (const request of await cache.keys()) {
        const response = await cache.match(request)
        if (!response) continue
        if (new URL(request.url).pathname === '/shared/text') {
          text = await response.text()
          continue
        }
        const blob = await response.blob()
        files.push(new File([blob], decodeURIComponent(response.headers.get('x-file-name') || 'shared-file'), { type: blob.type }))
      }
      await caches.delete(shareCache)
      if (files.length || text) setStaged({ files, text: files.length ? '' : text })
    })()
  }, [])

  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: EventTarget }).connection
    const update = () => {
      setCellular(onCellular())
      signalingRef.current?.send({ type: 'status', cellular: onCellular() })
    }
    connection?.addEventListener('change', update)
    return () => connection?.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    document.title = offers.length ? `(${offers.length}) Incoming files · PexyDrop` : 'PexyDrop'
  }, [offers.length])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 4200)
    return () => window.clearTimeout(timer)
  }, [toast])

  // Paste files or text anywhere on the page to queue them for sending.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      const files = Array.from(event.clipboardData?.files ?? [])
      const text = event.clipboardData?.getData('text') ?? ''
      if (files.length) setStaged({ files, text: '' })
      else if (text.trim()) setStaged({ files: [], text })
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [])

  const pairUrl = useMemo(() => {
    if (!room) return ''
    const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
    const base = isLoopback && addresses[0] ? `${location.protocol}//${addresses[0]}:${location.port}` : location.origin
    return `${base}/?room=${room}`
  }, [addresses, room])

  const siteAddress = useMemo(() => {
    const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
    return isLoopback && addresses[0] ? `${addresses[0]}:${location.port}` : location.host
  }, [addresses])

  const offer = offers[0]
  const offerFrom = offer ? peers.find((peer) => peer.id === offer.peerId) : undefined
  const promptPeer = dataPrompt ? peers.find((peer) => peer.id === dataPrompt.peerId) : undefined
  const showCellularNotice = cellular && !cellularDismissed && !Object.values(routes).includes('local')

  function sendFiles(peerId: string, files: File[]) {
    if (files.length) managerRef.current?.get(peerId).sendFiles(files)
  }

  function sendText(peerId: string, text: string) {
    return managerRef.current?.get(peerId).sendText(text)
  }

  function chooseFor(peer: RemotePeer) {
    if (staged?.files.length) {
      sendFiles(peer.id, staged.files)
      setStaged(null)
      return
    }
    if (staged?.text) {
      void sendText(peer.id, staged.text)?.then(() => setToast(`Text sent to ${peer.name}`), (error: Error) => setToast(error.message))
      setStaged(null)
      return
    }
    pickTargetRef.current = peer.id
    fileInputRef.current?.click()
  }

  function dropOnPage(event: DragEvent) {
    event.preventDefault()
    setPageDrag(false)
    const files = Array.from(event.dataTransfer.files)
    if (!files.length) return
    if (peers.length === 1) sendFiles(peers[0].id, files)
    else setStaged({ files, text: '' })
  }

  async function respond(accept: boolean) {
    if (!offer) return
    setOffers((current) => current.filter((item) => item.id !== offer.id))
    const link = managerRef.current?.get(offer.peerId)
    if (!accept) return link?.respond(offer.id, false)
    if (trustOffer) setTrusted((current) => [...new Set([...current, offer.peerId])])
    setTrustOffer(false)
    // Pressing Accept counts as the click browsers need before granting folder access.
    const useFolder = folder && (await folderReady(folder, true))
    link?.respond(offer.id, true, useFolder ? folder : undefined)
  }

  function answerDataPrompt(send: boolean) {
    dataPrompt?.resolve(send)
    setDataPrompt(null)
  }

  function saveName(event: FormEvent) {
    event.preventDefault()
    const next = nameDraft.trim().slice(0, 32)
    if (next) {
      setName(next)
      saveDeviceName(next)
      signalingRef.current?.send({ type: 'rename', name: next })
    } else {
      setNameDraft(name)
    }
    setEditingName(false)
  }

  function toggleAskBeforeData() {
    const next = !askBeforeData
    setAskBeforeData(next)
    storageSet(() => localStorage, askDataStorage, String(next))
  }

  function toggleAutoSave() {
    const next = !autoSave
    setAutoSave(next)
    storageSet(() => localStorage, autoSaveStorage, String(next))
  }

  async function chooseFolder() {
    try {
      setFolder(await pickSaveFolder())
    } catch (error) {
      if ((error as Error).name !== 'AbortError') setToast('That folder could not be used.')
    }
  }

  function useDownloads() {
    setFolder(null)
    void forgetSaveFolder()
  }

  function joinRoom(event: FormEvent) {
    event.preventDefault()
    const code = roomInput.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (code.length !== 6) return setRoomError('Codes are 6 characters long.')
    joinSourceRef.current = 'manual'
    signalingRef.current?.send({ type: 'join-room', code })
  }

  async function copy(id: string, text: string) {
    if (await copyText(text)) {
      setCopiedId(id)
      window.setTimeout(() => setCopiedId((current) => (current === id ? '' : current)), 1600)
    } else {
      setToast('Copying is not available in this browser.')
    }
  }

  async function share(file: File) {
    try {
      await navigator.share({ files: [file] })
    } catch (error) {
      if ((error as Error).name !== 'AbortError') setToast('Sharing is not available for this file.')
    }
  }

  function saveAll() {
    received.filter((item) => item.kind === 'file').forEach((item, index) => {
      window.setTimeout(() => download(item.url, item.file.name), index * 300)
    })
  }

  function clearReceived() {
    for (const item of received) if (item.kind === 'file') URL.revokeObjectURL(item.url)
    setReceived([])
  }

  function clearHistory() {
    setRecent(saveHistory([]))
  }

  const receivedFiles = received.filter((item) => item.kind === 'file')
  const canShareFiles = typeof navigator.canShare === 'function'
  const SelfIcon = deviceIcon(thisDevice)
  const hint = isComputer ? 'Click or drop files' : 'Tap to send'

  return (
    <main
      className="app-shell"
      onDragEnter={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setPageDrag(true) } }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={dropOnPage}
    >
      <input
        ref={fileInputRef}
        className="file-input"
        type="file"
        multiple
        onChange={(event) => {
          const target = pickTargetRef.current
          if (target && event.target.files) sendFiles(target, Array.from(event.target.files))
          pickTargetRef.current = null
          event.target.value = ''
        }}
      />

      <header className="topbar">
        <a className="brand" href="/" aria-label="PexyDrop home">
          <span className="brand-mark"><ArrowLeftRight size={18} strokeWidth={2.5} /></span>
          <span>pexy<span className="brand-light">drop</span></span>
        </a>
        <span className={`connection-pill ${online ? 'is-online' : ''}`} role="status">
          <span className="status-dot" />
          {online ? 'Online' : 'Connecting…'}
        </span>
      </header>

      {showCellularNotice && (
        <div className="notice is-warning" role="alert">
          <SignalIcon size={17} />
          <span><strong>You're on mobile data.</strong> For free, fast transfers, join the same Wi-Fi as your other device, or turn on your hotspot and connect the other device to it.</span>
          <button className="icon-button" onClick={() => setCellularDismissed(true)} aria-label="Dismiss"><X size={16} /></button>
        </div>
      )}

      <section className="workspace-grid">
        <div className="main-column">
          <section className="intro">
            <p className="eyebrow"><span /> DEVICE TO DEVICE · OVER YOUR WI-FI</p>
            <h1>Tap a device.<br /><span>Send anything.</span></h1>
            <p className="intro-copy">Open PexyDrop on any phone or computer on the same Wi-Fi or hotspot and it appears below. Files go straight across, encrypted, and are never uploaded to a server.</p>
          </section>

          {staged && (
            <div className="notice is-staged">
              {staged.files.length ? <Upload size={17} /> : <MessageSquareText size={17} />}
              <span>
                <strong>{staged.files.length ? `${plural(staged.files.length, 'file')} ready · ${formatBytes(staged.files.reduce((sum, file) => sum + file.size, 0))}` : 'Text ready to send'}</strong>
                {' '}{peers.length ? 'Choose a device to send to.' : 'Waiting for a device to appear.'}
              </span>
              <button className="icon-button" onClick={() => setStaged(null)} aria-label="Clear"><X size={16} /></button>
            </div>
          )}

          <div className="section-heading">
            <h2>Nearby devices</h2>
            <span className="count">{peers.length}</span>
          </div>

          {peers.length > 0 ? (
            <div className="device-grid">
              {peers.map((peer) => {
                const Icon = deviceIcon(peer.device)
                const transfer = transfers[peer.id]
                const active = transfer && !terminal.has(transfer.status)
                const progress = transfer && transfer.total ? transfer.transferred / transfer.total : 0
                const route = routes[peer.id]
                const waiting = queued[peer.id] ?? 0
                const isTrusted = trusted.includes(peer.id)
                return (
                  <article
                    key={peer.id}
                    className={`device-card ${dragTarget === peer.id ? 'is-drop-target' : ''} ${active ? 'is-busy' : ''} ${transfer?.status === 'done' ? 'is-done' : ''}`}
                    onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); setDragTarget(peer.id) }}
                    onDragLeave={() => setDragTarget(null)}
                    onDrop={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      setDragTarget(null)
                      setPageDrag(false)
                      sendFiles(peer.id, Array.from(event.dataTransfer.files))
                    }}
                  >
                    <button className="device-main" onClick={() => chooseFor(peer)} aria-label={active ? `Queue more files for ${peer.name}` : `Send files to ${peer.name}`}>
                      <span className="device-avatar">
                        {active && (transfer.status === 'sending' || transfer.status === 'receiving') && <ProgressRing value={progress} />}
                        {active && (transfer.status === 'connecting' || transfer.status === 'waiting') && <span className="pulse-ring" />}
                        {transfer?.status === 'done' ? <Check size={26} /> : <Icon size={26} strokeWidth={1.7} />}
                      </span>
                      <span className="device-name" title={peer.name}>{peer.name}</span>
                      <span className="device-detail">{peer.detail || 'Web browser'}</span>
                      <span className={`device-status status-${transfer?.status ?? 'idle'}`}>{transfer ? describeTransfer(transfer) : hint}</span>
                      {waiting > 0 && <span className="queue-chip">+{waiting} queued</span>}
                    </button>
                    <div className="device-foot">
                      <span className={`route-badge ${route === 'internet' ? 'is-internet' : ''}`}>
                        {route === 'relay' ? <><Server size={12} /> Via server</> : route === 'internet' ? <><Globe size={12} /> Internet</> : route === 'local' ? <><Wifi size={12} /> Local</> : peer.via === 'code' ? <><Link2 size={12} /> Paired</> : <><Wifi size={12} /> Nearby</>}
                      </span>
                      <span className="foot-actions">
                        {isTrusted && (
                          <button className="trust-chip" onClick={() => setTrusted((current) => current.filter((id) => id !== peer.id))} title="Stop auto-accepting from this device">
                            <ShieldCheck size={12} /> Auto
                          </button>
                        )}
                        {active
                          ? <button className="mini-button" onClick={() => managerRef.current?.get(peer.id).cancel(transfer.id)}>Cancel</button>
                          : <button className="mini-button" onClick={() => { setComposeFor(peer); setDraft('') }} aria-label={`Send text to ${peer.name}`}><MessageSquareText size={14} /> Text</button>}
                      </span>
                    </div>
                  </article>
                )
              })}
            </div>
          ) : (
            <div className="empty-radar">
              <div className="radar" aria-hidden="true"><span /><span /><span /><SelfIcon size={24} /></div>
              <p>{online ? 'Looking for devices…' : 'Connecting to PexyDrop…'}</p>
              <span>Open <strong>{siteAddress}</strong> on your other device while it's on this Wi-Fi, or pair with the code{isComputer ? '' : ' below'}.</span>
              <div className="hotspot-tip">
                <Wifi size={16} />
                <span><strong>No shared Wi-Fi?</strong> Turn on your phone's hotspot and connect the laptop to it. Transfers between the two stay free and don't use your data plan.</span>
              </div>
            </div>
          )}

          {received.length > 0 && (
            <section className="received">
              <div className="section-heading">
                <h2>Received</h2>
                <span className="count">{received.length}</span>
                <div className="heading-actions">
                  {receivedFiles.length > 1 && <button className="ghost-button" onClick={saveAll}><Download size={14} /> Save all</button>}
                  <button className="ghost-button" onClick={clearReceived}><Trash2 size={14} /> Clear</button>
                </div>
              </div>
              <div className="received-list">
                {received.map((item) => {
                  if (item.kind === 'text') {
                    return (
                      <article className="received-row" key={item.id}>
                        <span className="file-icon"><MessageSquareText size={18} /></span>
                        <div className="file-meta"><p title={item.text}>{item.text}</p><span>Text from {item.from}</span></div>
                        {isLink(item.text) && <a className="icon-button row-action" href={item.text.trim()} target="_blank" rel="noreferrer" aria-label="Open link" title="Open link"><ExternalLink size={16} /></a>}
                        <button className="icon-button row-action" onClick={() => void copy(item.id, item.text)} aria-label="Copy text" title="Copy">{copiedId === item.id ? <Check size={16} /> : <Copy size={16} />}</button>
                      </article>
                    )
                  }
                  if (item.kind === 'saved') {
                    return (
                      <article className="received-row" key={item.id}>
                        <span className="file-icon"><FolderOpen size={18} /></span>
                        <div className="file-meta"><p title={item.name}>{item.name}</p><span>{formatBytes(item.size)} · from {item.from}</span></div>
                        <span className="saved-tag"><Check size={14} /> In {item.folder}</span>
                      </article>
                    )
                  }
                  const Icon = fileIcon(item.file.type)
                  return (
                    <article className="received-row" key={item.id}>
                      {item.file.type.startsWith('image/')
                        ? <img className="thumb" src={item.url} alt="" />
                        : <span className="file-icon"><Icon size={18} /></span>}
                      <div className="file-meta"><p title={item.file.name}>{item.file.name}</p><span>{formatBytes(item.file.size)} · from {item.from}</span></div>
                      {canShareFiles && navigator.canShare({ files: [item.file] }) && (
                        <button className="icon-button row-action" onClick={() => void share(item.file)} aria-label={`Share ${item.file.name}`} title="Share or save to Photos"><Share2 size={16} /></button>
                      )}
                      <a className="save-button" href={item.url} download={item.file.name}><Download size={15} /> Save</a>
                    </article>
                  )
                })}
              </div>
            </section>
          )}

          {recent.length > 0 && (
            <details className="history">
              <summary>
                <History size={16} />
                <span>History</span>
                <span className="count">{recent.length}</span>
              </summary>
              <div className="history-list">
                {recent.map((entry) => (
                  <div className="history-row" key={entry.id}>
                    <span className={`history-icon ${entry.direction === 'send' ? 'is-sent' : ''}`}>
                      {entry.direction === 'send' ? <ArrowUpRight size={15} /> : <ArrowDownLeft size={15} />}
                    </span>
                    <div className="file-meta">
                      <p title={entry.names.join(', ')}>{entry.count === 1 ? entry.names[0] : `${entry.names.join(', ')}${entry.count > entry.names.length ? ` + ${entry.count - entry.names.length} more` : ''}`}</p>
                      <span>{entry.direction === 'send' ? 'Sent to' : 'Received from'} {entry.peer} · {formatBytes(entry.total)} · {formatWhen(entry.at)}</span>
                    </div>
                  </div>
                ))}
                <button className="text-button" onClick={clearHistory}><Trash2 size={13} /> Clear history</button>
              </div>
            </details>
          )}
        </div>

        <aside className="side-column">
          <section className="panel identity">
            <span className="identity-avatar"><SelfIcon size={20} /></span>
            <div className="identity-copy">
              <span className="label">You appear as</span>
              {editingName ? (
                <form onSubmit={saveName}>
                  <input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} onBlur={saveName} maxLength={32} autoFocus aria-label="Device name" />
                </form>
              ) : (
                <button className="name-button" onClick={() => { setNameDraft(name); setEditingName(true) }}>{name} <Pencil size={13} /></button>
              )}
            </div>
          </section>

          <section className="panel pair-panel">
            <div className="panel-topline"><Link2 size={15} /><span>PAIR WITH A CODE</span></div>
            <p className="panel-copy">Not seeing your device? Hotspots, different Wi-Fi bands or a VPN can hide it. Scan this QR code or enter the code on the other device.</p>
            {room ? (
              <>
                <div className="qr-frame">
                  <QRCodeSVG value={pairUrl} size={164} level="M" bgColor="#ffffff" fgColor="#2a1a4a" />
                </div>
                <button className="code-display" onClick={() => void copy('room', pairUrl)} title="Copy pairing link">
                  <span>{formatCode(room)}</span>
                  {copiedId === 'room' ? <Check size={15} /> : <Copy size={15} />}
                </button>
                <button className="text-button" onClick={() => signalingRef.current?.send({ type: 'leave-room' })}><LogOut size={13} /> Stop using this code</button>
              </>
            ) : (
              <button className="secondary-button" onClick={() => signalingRef.current?.send({ type: 'create-room' })} disabled={!online}>Show a pairing code</button>
            )}
            <form className="join-form" onSubmit={joinRoom}>
              <input
                value={roomInput}
                onChange={(event) => { setRoomInput(event.target.value.toUpperCase()); setRoomError('') }}
                placeholder="Enter code"
                maxLength={7}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                aria-label="Pairing code"
              />
              <button type="submit" disabled={!online || !roomInput.trim()}>Join</button>
            </form>
            {roomError && <p className="form-error">{roomError}</p>}
          </section>

          <section className="panel settings">
            <Toggle
              title="Ask before using data"
              description="Same Wi-Fi or hotspot is always free. You'll be asked before a transfer goes over the internet."
              checked={askBeforeData}
              onChange={toggleAskBeforeData}
            />
            {canSaveToFolder && isComputer && (
              <div className="folder-row">
                <span>
                  <strong>Save to</strong>
                  <small>{folder ? <>Files go straight into <b>{folder.name || 'your folder'}</b>, even very large ones.</> : 'Browser downloads. Pick a folder to save large files straight to disk.'}</small>
                </span>
                <span className="folder-actions">
                  <button className="mini-button" onClick={() => void chooseFolder()}><FolderOpen size={14} /> {folder ? 'Change' : 'Choose'}</button>
                  {folder && <button className="icon-button row-action" onClick={useDownloads} aria-label="Use browser downloads instead" title="Use browser downloads"><X size={15} /></button>}
                </span>
              </div>
            )}
            {!folder && (
              <Toggle
                title="Save files automatically"
                description="Download each file as soon as it arrives, without pressing Save."
                checked={autoSave}
                onChange={toggleAutoSave}
              />
            )}
            <p className="privacy-note"><ShieldCheck size={15} /> Files are encrypted end to end and go directly between devices. You approve every incoming transfer.</p>
          </section>
        </aside>
      </section>

      <footer className="footer"><span><span className="footer-dot" /> DIRECT · ENCRYPTED · NO UPLOADS</span><span>PexyDrop</span></footer>

      {pageDrag && (
        <div className="drag-overlay" onDragLeave={(event) => { if (event.target === event.currentTarget) setPageDrag(false) }}>
          <div><Upload size={30} /><strong>{peers.length === 1 ? `Drop to send to ${peers[0].name}` : 'Drop to queue files'}</strong><span>{peers.length > 1 ? 'Then pick a device, or drop straight onto one.' : 'They go straight to the other device.'}</span></div>
        </div>
      )}

      {dataPrompt && (
        <div className="backdrop">
          <section className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="data-title">
            <span className="dialog-mark is-warning"><SignalIcon size={20} /></span>
            <h2 id="data-title">{dataPrompt.route === 'relay' ? 'Send through the server?' : 'Send over the internet?'}</h2>
            <p className="dialog-copy">
              {dataPrompt.route === 'relay'
                ? `This network won't let the devices connect directly, so this ${formatBytes(dataPrompt.bytes)} transfer would go through PexyDrop's server, still encrypted. It uses your internet connection, which may be mobile data.`
                : `${promptPeer?.name ?? 'That device'} isn't on your Wi-Fi or hotspot, so this ${formatBytes(dataPrompt.bytes)} transfer would go over the internet and may use mobile data.`}
            </p>
            <p className="dialog-tip"><Wifi size={14} /> To send for free, join the same Wi-Fi, or connect one device to the other's hotspot.</p>
            <div className="dialog-actions">
              <button className="secondary-button" onClick={() => answerDataPrompt(false)}>Don't send</button>
              <button className="primary-button" onClick={() => answerDataPrompt(true)} autoFocus>Send anyway</button>
            </div>
          </section>
        </div>
      )}

      {!dataPrompt && offer && (
        <div className="backdrop">
          <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="offer-title">
            <span className="dialog-mark"><Download size={20} /></span>
            <p className="eyebrow"><span /> INCOMING</p>
            <h2 id="offer-title">{offerFrom?.name ?? 'A nearby device'} wants to send you {plural(offer.files.length, 'file')}</h2>
            <p className="dialog-copy">{formatBytes(offer.total)} total{routes[offer.peerId] === 'relay' ? ' · through the server, encrypted' : routes[offer.peerId] === 'internet' ? '' : ' · over your local network'}{folder ? ` · saves to ${folder.name || 'your folder'}` : ''}</p>
            {(routes[offer.peerId] === 'internet' || (routes[offer.peerId] === 'relay' && (cellular || offerFrom?.cellular))) && (
              <p className="dialog-warning"><TriangleAlert size={15} /> This may use about {formatBytes(offer.total)} of mobile data.</p>
            )}
            <ul className="offer-files">
              {offer.files.slice(0, 4).map((file, index) => {
                const Icon = fileIcon(file.type)
                return <li key={index}><Icon size={15} /><span>{file.name}</span><small>{formatBytes(file.size)}</small></li>
              })}
              {offer.files.length > 4 && <li className="more">+ {plural(offer.files.length - 4, 'more file')}</li>}
            </ul>
            <label className="check-row">
              <input type="checkbox" checked={trustOffer} onChange={(event) => setTrustOffer(event.target.checked)} />
              <span>Accept future files from {offerFrom?.name ?? 'this device'} automatically while this page is open</span>
            </label>
            <div className="dialog-actions">
              <button className="secondary-button" onClick={() => void respond(false)}>Decline</button>
              <button className="primary-button" onClick={() => void respond(true)} autoFocus><Check size={16} /> Accept</button>
            </div>
          </section>
        </div>
      )}

      {!dataPrompt && !offer && shownText && (
        <div className="backdrop" onClick={(event) => { if (event.target === event.currentTarget) setShownText(null) }}>
          <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="text-title">
            <span className="dialog-mark"><MessageSquareText size={20} /></span>
            <h2 id="text-title">Text from {shownText.from}</h2>
            <pre className="text-body">{shownText.text}</pre>
            <div className="dialog-actions">
              <button className="secondary-button" onClick={() => setShownText(null)}>Close</button>
              {isLink(shownText.text)
                ? <a className="primary-button" href={shownText.text.trim()} target="_blank" rel="noreferrer" onClick={() => setShownText(null)}><ExternalLink size={16} /> Open link</a>
                : <button className="primary-button" onClick={() => void copy('dialog', shownText.text)}>{copiedId === 'dialog' ? <Check size={16} /> : <Copy size={16} />} {copiedId === 'dialog' ? 'Copied' : 'Copy'}</button>}
            </div>
          </section>
        </div>
      )}

      {composeFor && (
        <div className="backdrop" onClick={(event) => { if (event.target === event.currentTarget) setComposeFor(null) }}>
          <form
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="compose-title"
            onSubmit={(event) => {
              event.preventDefault()
              const target = composeFor
              if (!draft.trim()) return
              void sendText(target.id, draft)?.then(() => setToast(`Text sent to ${target.name}`), (error: Error) => setToast(error.message))
              setComposeFor(null)
            }}
          >
            <span className="dialog-mark"><MessageSquareText size={20} /></span>
            <h2 id="compose-title">Send text to {composeFor.name}</h2>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Paste a link, a note, a code…" rows={5} autoFocus />
            <div className="dialog-actions">
              <button type="button" className="secondary-button" onClick={() => setComposeFor(null)}>Cancel</button>
              <button type="submit" className="primary-button" disabled={!draft.trim()}><Send size={15} /> Send</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}<button onClick={() => setToast('')} aria-label="Dismiss notification"><X size={15} /></button></div>}
    </main>
  )
}
