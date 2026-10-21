// Folder access (Chrome and Edge on desktop) and transfer history.

type PermissionedHandle = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { id?: string; mode?: 'readwrite'; startIn?: string }) => Promise<FileSystemDirectoryHandle>
}

const databaseName = 'pexydrop'
const handleKey = 'save-folder'
const historyStorage = 'pexydrop-history'
const historyLimit = 40

export const canSaveToFolder = typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function'

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('handles')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase()
  return new Promise<T>((resolve, reject) => {
    const request = run(database.transaction('handles', mode).objectStore('handles'))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).finally(() => database.close())
}

export async function loadSaveFolder() {
  if (!canSaveToFolder) return null
  try {
    return (await withStore<FileSystemDirectoryHandle | undefined>('readonly', (store) => store.get(handleKey))) ?? null
  } catch {
    return null
  }
}

export async function pickSaveFolder() {
  const folder = await (window as DirectoryPickerWindow).showDirectoryPicker!({ id: 'pexydrop', mode: 'readwrite', startIn: 'downloads' })
  await withStore('readwrite', (store) => store.put(folder, handleKey)).catch(() => {})
  return folder
}

export async function forgetSaveFolder() {
  await withStore('readwrite', (store) => store.delete(handleKey)).catch(() => {})
}

// Browsers ask again for folder access in each new visit. Asking needs a click,
// so pass interactive only when called from one (such as pressing Accept).
export async function folderReady(folder: FileSystemDirectoryHandle, interactive: boolean) {
  const handle = folder as PermissionedHandle
  try {
    if ((await handle.queryPermission?.({ mode: 'readwrite' })) === 'granted') return true
    if (!interactive) return false
    return (await handle.requestPermission?.({ mode: 'readwrite' })) === 'granted'
  } catch {
    return false
  }
}

export type HistoryEntry = {
  id: string
  direction: 'send' | 'receive'
  peer: string
  names: string[]
  count: number
  total: number
  at: number
}

export function loadHistory(): HistoryEntry[] {
  try {
    const saved = JSON.parse(localStorage.getItem(historyStorage) ?? '[]')
    return Array.isArray(saved) ? saved : []
  } catch {
    return []
  }
}

export function saveHistory(entries: HistoryEntry[]) {
  const trimmed = entries.slice(0, historyLimit)
  try {
    localStorage.setItem(historyStorage, JSON.stringify(trimmed))
  } catch {
    // History is a convenience; skip it when storage is unavailable.
  }
  return trimmed
}
