import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  ArrowDownToLine,
  ArrowLeftRight,
  Check,
  Copy,
  Download,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  HardDrive,
  Laptop,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Smartphone,
  Trash2,
  Upload,
  Wifi,
  X,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'

type TransferFile = {
  id: string
  name: string
  size: number
  type: string
  createdAt: string
}

type ServerInfo = {
  addresses: string[]
  pairingKey: string | null
  port: number
  publicUrl: string | null
  requiresPassword: boolean
  setupRequired: boolean
}

const keyStorage = 'pexydrop-pairing-key'
const passwordStorage = 'pexydrop-transfer-password'

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

function fileIcon(type: string) {
  if (type.startsWith('image/')) return FileImage
  if (type.startsWith('video/')) return FileVideo
  if (type.startsWith('audio/')) return FileAudio
  if (type.includes('zip') || type.includes('compressed')) return FileArchive
  if (type.includes('text') || type.includes('pdf')) return FileText
  return File
}

function getApiKey() {
  const fromUrl = new URLSearchParams(window.location.search).get('key')
  if (fromUrl) {
    localStorage.setItem(keyStorage, fromUrl)
    return fromUrl
  }
  return localStorage.getItem(keyStorage) ?? ''
}

export default function App() {
  const [apiKey, setApiKey] = useState(getApiKey)
  const [accessPassword, setAccessPassword] = useState(() => sessionStorage.getItem(passwordStorage) ?? '')
  const [passwordInput, setPasswordInput] = useState('')
  const [requiresPassword, setRequiresPassword] = useState(false)
  const [isUnlocking, setIsUnlocking] = useState(false)
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null)
  const [files, setFiles] = useState<TransferFile[]>([])
  const [isOnline, setIsOnline] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [search, setSearch] = useState('')
  const [toast, setToast] = useState('')
  const [copied, setCopied] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const request = useCallback(async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, {
      ...init,
      headers: { 'x-transfer-key': apiKey, ...init.headers },
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.error || `Request failed (${response.status})`)
    }
    return response
  }, [apiKey])

  const refreshFiles = useCallback(async () => {
    if (!apiKey) return
    try {
      const response = await request('/api/files')
      setFiles(await response.json())
      setIsOnline(true)
    } catch {
      setIsOnline(false)
    }
  }, [apiKey, request])

  useEffect(() => {
    const headers: Record<string, string> = {}
    if (apiKey) headers['x-transfer-key'] = apiKey
    if (accessPassword) headers['x-transfer-password'] = accessPassword
    fetch('/api/info', { headers }).then((response) => response.json()).then((info: ServerInfo) => {
      setServerInfo(info)
      setRequiresPassword(info.requiresPassword)
      if (info.requiresPassword) {
        localStorage.removeItem(keyStorage)
        setApiKey('')
      }
      if (info.pairingKey) {
        localStorage.setItem(keyStorage, info.pairingKey)
        setApiKey(info.pairingKey)
      }
    }).catch(() => setIsOnline(false))
  }, [])

  useEffect(() => {
    void refreshFiles()
    const timer = window.setInterval(() => void refreshFiles(), 4000)
    return () => window.clearInterval(timer)
  }, [refreshFiles])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 3200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const transferUrl = useMemo(() => {
    if (!serverInfo || !apiKey) return ''
    const address = serverInfo.addresses[0]
    const url = new URL(serverInfo.publicUrl || window.location.href)
    if (address) {
      url.hostname = address
      url.port = String(serverInfo.port === 4173 && window.location.port ? window.location.port : serverInfo.port)
    } else if (!serverInfo.publicUrl) {
      url.port = window.location.port
    }
    url.search = ''
    url.hash = ''
    url.searchParams.set('key', apiKey)
    return url.toString()
  }, [apiKey, serverInfo])

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  const filteredFiles = files.filter((file) => file.name.toLowerCase().includes(search.toLowerCase()))

  function uploadFiles(selected: FileList | File[]) {
    if (!selected.length) return
    const form = new FormData()
    Array.from(selected).forEach((file) => form.append('files', file))
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/files')
    xhr.setRequestHeader('x-transfer-key', apiKey)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) setUploadProgress(Math.round((event.loaded / event.total) * 100))
    }
    xhr.onload = () => {
      setIsUploading(false)
      if (xhr.status >= 200 && xhr.status < 300) {
        const uploaded: TransferFile[] = JSON.parse(xhr.responseText)
        setToast(`${uploaded.length} ${uploaded.length === 1 ? 'file' : 'files'} added to this device`)
        void refreshFiles()
      } else {
        let message = 'Upload failed. Check your connection and try again.'
        try { message = JSON.parse(xhr.responseText).error || message } catch { /* Keep fallback message. */ }
        setToast(message)
      }
      setUploadProgress(0)
    }
    xhr.onerror = () => {
      setIsUploading(false)
      setToast('Connection interrupted. Your original files are unchanged.')
      setUploadProgress(0)
    }
    setIsUploading(true)
    setUploadProgress(0)
    xhr.send(form)
  }

  async function deleteFile(file: TransferFile) {
    try {
      await request(`/api/files/${file.id}`, { method: 'DELETE' })
      setFiles((current) => current.filter((item) => item.id !== file.id))
      setToast(`${file.name} removed`)
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Could not remove file')
    }
  }

  async function downloadAll() {
    const link = document.createElement('a')
    link.href = `/api/archive?key=${encodeURIComponent(apiKey)}`
    link.download = 'pexydrop.zip'
    link.click()
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(transferUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setToast('Clipboard access is unavailable in this browser')
    }
  }

  async function unlockTransfers(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsUnlocking(true)
    try {
      const response = await fetch('/api/info', { headers: { 'x-transfer-password': passwordInput } })
      const info: ServerInfo = await response.json()
      if (info.requiresPassword || !info.pairingKey) {
        setToast(info.setupRequired ? 'Transfer access has not been configured by the host yet.' : 'That transfer password did not unlock this session.')
        return
      }
      sessionStorage.setItem(passwordStorage, passwordInput)
      localStorage.setItem(keyStorage, info.pairingKey)
      setAccessPassword(passwordInput)
      setApiKey(info.pairingKey)
      setServerInfo(info)
      setRequiresPassword(false)
    } catch {
      setToast('Could not reach the transfer service. Try again.')
    } finally {
      setIsUnlocking(false)
    }
  }

  return (
    <main className="app-shell" onDragEnter={(event) => { event.preventDefault(); setIsDragging(true) }}>
      <header className="topbar">
        <a className="brand" href="/" aria-label="PexyDrop home">
          <span className="brand-mark"><ArrowLeftRight size={19} strokeWidth={2.5} /></span>
          <span>pexy<span className="brand-light">drop</span></span>
        </a>
        <div className="topbar-right">
          <span className={`connection-pill ${isOnline ? 'is-online' : ''}`}>
            <span className="status-dot" />
            {isOnline ? (serverInfo && serverInfo.addresses.length === 0 ? 'Hosted session ready' : 'Ready on this network') : 'Connecting'}
          </span>
          <span className="topbar-divider" />
          <span className="device-label"><Laptop size={16} /> This device</span>
        </div>
      </header>

      <section className="intro-row">
        <div>
          <p className="eyebrow"><span /> PRIVATE LOCAL TRANSFER</p>
          <h1>Move files.<br /><span>Keep your flow.</span></h1>
          <p className="intro-copy">{serverInfo && serverInfo.addresses.length === 0 ? 'A private, passphrase-protected file relay.' : 'A direct bridge between your devices. No accounts, no cloud detours.'}</p>
        </div>
        <div className="network-note"><ShieldCheck size={17} /><span>{serverInfo && serverInfo.addresses.length === 0 ? 'Transfers pass through the host' : 'Files stay on your network'}</span></div>
      </section>

      <section className="workspace-grid">
        <div className="main-column">
          <div
            className={`drop-zone ${isDragging ? 'is-dragging' : ''} ${isUploading ? 'is-uploading' : ''}`}
            onDragOver={(event) => { event.preventDefault(); setIsDragging(true) }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setIsDragging(false) }}
            onDrop={(event) => { event.preventDefault(); setIsDragging(false); uploadFiles(event.dataTransfer.files) }}
            onDragEnd={() => setIsDragging(false)}
          >
            <input ref={inputRef} className="file-input" type="file" multiple onChange={(event) => { if (event.target.files) uploadFiles(event.target.files); event.target.value = '' }} />
            <div className="drop-orbit orbit-one" /><div className="drop-orbit orbit-two" />
            <div className="upload-symbol"><Upload size={22} strokeWidth={1.8} /></div>
            <div className="drop-copy">
              <h2>{isUploading ? 'Sending your files' : isDragging ? 'Drop to send' : 'Send files to this device'}</h2>
              <p>{isUploading ? 'Keep this tab open while the transfer finishes.' : 'Drop them here, or browse your device.'}</p>
            </div>
            <button className="browse-button" onClick={() => inputRef.current?.click()} disabled={isUploading}>
              {isUploading ? <LoaderCircle className="spin" size={17} /> : <Upload size={17} />}
              {isUploading ? `${uploadProgress}%` : 'Choose files'}
            </button>
            {isUploading && <div className="progress-track"><span style={{ width: `${uploadProgress}%` }} /></div>}
            <div className="drop-foot"><span>Any file type</span><i /><span>Large files supported</span><i /><span>Originals stay untouched</span></div>
          </div>

          <div className="files-heading">
            <div className="files-title">
              <h2>On this device</h2>
              <span className="file-count">{files.length}</span>
            </div>
            <div className="files-actions">
              <span className="storage-total"><HardDrive size={15} /> {formatBytes(totalBytes)}</span>
              <button className="icon-button refresh-button" aria-label="Refresh file list" title="Refresh" onClick={() => void refreshFiles()}><RefreshCw size={16} /></button>
              {files.length > 0 && <button className="download-all" onClick={() => void downloadAll()}><Download size={15} /> Download all</button>}
            </div>
          </div>

          {files.length > 0 && <label className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a file" /><kbd>⌘ K</kbd></label>}

          <div className="file-list">
            {filteredFiles.map((file, index) => {
              const Icon = fileIcon(file.type)
              return (
                <article className="file-row" key={file.id} style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}>
                  <div className="file-icon"><Icon size={19} strokeWidth={1.8} /></div>
                  <div className="file-meta"><p title={file.name}>{file.name}</p><span>{formatBytes(file.size)} <i /> {new Date(file.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></div>
                  <span className="received-tag"><Check size={13} /> Ready</span>
                  <a className="icon-button file-action" href={`/api/files/${file.id}/download?key=${encodeURIComponent(apiKey)}`} download={file.name} aria-label={`Download ${file.name}`} title="Download"><ArrowDownToLine size={17} /></a>
                  <button className="icon-button file-action remove-action" onClick={() => void deleteFile(file)} aria-label={`Remove ${file.name}`} title="Remove"><Trash2 size={16} /></button>
                </article>
              )
            })}
            {files.length === 0 && <div className="empty-state"><div className="empty-icon"><File size={21} /></div><p>No files here yet</p><span>Files sent from your phone will show up here.</span></div>}
            {files.length > 0 && filteredFiles.length === 0 && <div className="no-results">No files match “{search}”.</div>}
          </div>
        </div>

        <aside className="pair-panel">
          <div className="pair-topline"><span className="pair-icon"><Smartphone size={17} /></span><span>PAIR A DEVICE</span><span className="pair-step">01 / 01</span></div>
          <h2>Make the<br />connection.</h2>
          <p className="pair-description">{serverInfo && serverInfo.addresses.length === 0 ? 'Open this private session link on the device you want to pair.' : 'Scan with your phone camera. Both devices should be on the same Wi-Fi.'}</p>
          <div className="qr-frame">
            {transferUrl ? <QRCodeSVG value={transferUrl} size={172} level="M" bgColor="#ffffff" fgColor="#182923" includeMargin={false} /> : <div className="qr-loading"><LoaderCircle className="spin" size={24} /></div>}
            <span className="qr-corner corner-tl" /><span className="qr-corner corner-tr" /><span className="qr-corner corner-bl" /><span className="qr-corner corner-br" />
          </div>
          <div className="pair-divider"><span /><p>OR OPEN THIS LINK</p><span /></div>
          <button className="link-copy" onClick={() => void copyLink()} disabled={!transferUrl}>
            <span className="link-glyph"><Wifi size={15} /></span>
            <span className="link-address">{serverInfo?.publicUrl ? new URL(serverInfo.publicUrl).host : serverInfo?.addresses[0] ? `${serverInfo.addresses[0]}:${window.location.port || serverInfo.port}` : serverInfo ? window.location.host : 'Waiting for network address'}</span>
            <span className="copy-icon">{copied ? <Check size={16} /> : <Copy size={15} />}</span>
          </button>
          <p className="pair-security"><ShieldCheck size={15} />{serverInfo && serverInfo.addresses.length === 0 ? 'Access requires the host-shared passphrase.' : ' Session link for devices on your network.'}</p>
          <div className="pair-bottom"><div className="device-avatars"><span><Laptop size={14} /></span><span><Smartphone size={14} /></span></div><span>Ready for phone ↔ laptop</span><span className="pair-online-dot" /></div>
        </aside>
      </section>

      <footer className="footer"><span><span className="footer-dot" />{serverInfo && serverInfo.addresses.length === 0 ? ' PASSWORD-PROTECTED RELAY' : ' DIRECT · PRIVATE · YOURS'}</span><span>PexyDrop <i /> {serverInfo && serverInfo.addresses.length === 0 ? 'Hosted transfer session' : 'Built for your local network'}</span></footer>

      {isDragging && <div className="drag-overlay" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); setIsDragging(false); uploadFiles(event.dataTransfer.files) }}><div><Upload size={30} /><strong>Drop to send</strong><span>Files will be available on every paired device</span></div></div>}
      {toast && <div className="toast"><span><Check size={15} /></span>{toast}<button onClick={() => setToast('')} aria-label="Dismiss notification"><X size={15} /></button></div>}
      {requiresPassword && serverInfo && <div className="access-backdrop">
        <section className="access-dialog" role="dialog" aria-modal="true" aria-labelledby="access-title">
          <span className="access-mark"><ShieldCheck size={20} /></span>
          <p className="eyebrow"><span /> PRIVATE TRANSFER SESSION</p>
          <h2 id="access-title">{serverInfo.setupRequired ? 'Access is not configured.' : 'Unlock PexyDrop.'}</h2>
          <p>{serverInfo.setupRequired ? 'The host must set TRANSFER_PASSWORD in the deployment settings before this service can accept transfers.' : 'Enter the transfer password shared by the person hosting this session.'}</p>
          {!serverInfo.setupRequired && <form onSubmit={(event) => void unlockTransfers(event)}>
            <label htmlFor="transfer-password">Transfer password</label>
            <input id="transfer-password" type="password" autoComplete="current-password" value={passwordInput} onChange={(event) => setPasswordInput(event.target.value)} autoFocus required />
            <button type="submit" disabled={isUnlocking}>{isUnlocking ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}{isUnlocking ? 'Checking' : 'Unlock transfers'}</button>
          </form>}
          <span className="access-foot">Files are stored only on the PexyDrop server.</span>
        </section>
      </div>}
    </main>
  )
}