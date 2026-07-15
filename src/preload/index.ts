import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  EVENT_FOCUS_SESSION,
  EVENT_OPEN_SETTINGS,
  EVENT_PTY_DATA,
  EVENT_STATE,
  ipcChannel,
  type AppState,
  type IpcApi,
  type PtyDataEvent
} from '../shared/ipc'

const invoke = (method: Parameters<typeof ipcChannel>[0], ...args: unknown[]): Promise<never> =>
  ipcRenderer.invoke(ipcChannel(method), ...args) as Promise<never>

const subscribe = <T>(channel: string, cb: (payload: T) => void): (() => void) => {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// Resolve dropped/pasted files here in the preload — webUtils.getPathForFile only
// works on the real File object, which does not survive crossing the contextBridge.
// Drag-drop, file paste, AND image paste all funnel through onFileDrop as paths, so
// they work identically whether the focus is a chat input or the xterm terminal.
const dropCbs = new Set<(drop: { sessionId: string | null; paths: string[] }) => void>()

// walk up from the event target to the session card it happened on
const sessionIdFor = (target: EventTarget | null): string | null => {
  let el = target as HTMLElement | null
  while (el && el.dataset?.sessionId === undefined) el = el.parentElement
  return el?.dataset.sessionId ?? null
}
const emitPaths = (target: EventTarget | null, paths: string[]): void => {
  const sessionId = sessionIdFor(target)
  for (const cb of dropCbs) cb({ sessionId, paths })
}
// on-disk files (dropped, or a file copied from Finder) → their paths
const routeFiles = (target: EventTarget | null, files: FileList | undefined): boolean => {
  const paths = [...(files ?? [])].map((f) => webUtils.getPathForFile(f)).filter(Boolean)
  if (paths.length === 0) return false
  emitPaths(target, paths)
  return true
}
// an in-memory pasted image (screenshot) → save the bytes to a temp file, insert its path
const routeImage = (target: EventTarget | null, data: DataTransfer | null): boolean => {
  const item = [...(data?.items ?? [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'))
  const file = item?.getAsFile()
  if (!file) return false
  void file.arrayBuffer().then(async (buf) => {
    const path = await invoke('savePastedImage', new Uint8Array(buf), item!.type.split('/')[1] || 'png')
    emitPaths(target, [path])
  })
  return true
}

// capture phase so xterm/other elements can't swallow the event before we see it.
// preventDefault on dragover stops the window from navigating to the dropped file.
window.addEventListener('dragover', (e) => e.preventDefault(), true)
window.addEventListener('drop', (e) => {
  if ((e.dataTransfer?.files.length ?? 0) === 0) return // let normal text drops through
  e.preventDefault()
  e.stopPropagation()
  routeFiles(e.target, e.dataTransfer?.files)
}, true)
window.addEventListener('paste', (e) => {
  // file path first (Finder copy), else a pasted image; plain text falls through
  if (routeFiles(e.target, e.clipboardData?.files) || routeImage(e.target, e.clipboardData)) {
    e.preventDefault()
    e.stopPropagation()
  }
}, true)

const api: IpcApi = {
  getAppInfo: () => invoke('getAppInfo'),
  getState: () => invoke('getState'),
  pickDirectory: () => invoke('pickDirectory'),

  discoverAccounts: () => invoke('discoverAccounts'),
  registerAccount: (input) => invoke('registerAccount', input),
  updateAccountNote: (dir, note) => invoke('updateAccountNote', dir, note),
  refreshAuth: (dir) => invoke('refreshAuth', dir),
  refreshAllUsage: () => invoke('refreshAllUsage'),
  startLogin: (dir) => invoke('startLogin', dir),
  submitLoginCode: (dir, code) => invoke('submitLoginCode', dir, code),
  cancelLogin: (dir) => invoke('cancelLogin', dir),
  removeAccount: (dir) => invoke('removeAccount', dir),

  createSession: (input) => invoke('createSession', input),
  restartSession: (id) => invoke('restartSession', id),
  removeSession: (id) => invoke('removeSession', id),
  switchAccount: (id, dir) => invoke('switchAccount', id, dir),
  updateSessionConfig: (id, patch) => invoke('updateSessionConfig', id, patch),
  reorderSessions: (ids) => invoke('reorderSessions', ids),
  savePastedImage: (bytes, ext) => invoke('savePastedImage', bytes, ext),
  ptyWrite: (id, data) => invoke('ptyWrite', id, data),
  ptySubmit: (id, text) => invoke('ptySubmit', id, text),
  ptyResize: (id, cols, rows) => invoke('ptyResize', id, cols, rows),
  ptySnapshot: (id) => invoke('ptySnapshot', id),

  popOutSession: (id) => invoke('popOutSession', id),
  focusPoppedOut: (id) => invoke('focusPoppedOut', id),

  onFileDrop: (cb) => {
    dropCbs.add(cb)
    return () => dropCbs.delete(cb)
  },

  onStateChanged: (cb) => subscribe<AppState>(EVENT_STATE, cb),
  onPtyData: (cb) => subscribe<PtyDataEvent>(EVENT_PTY_DATA, cb),
  onFocusSession: (cb) => subscribe<string>(EVENT_FOCUS_SESSION, cb),
  onOpenSettings: (cb) => subscribe<void>(EVENT_OPEN_SETTINGS, () => cb())
}

contextBridge.exposeInMainWorld('api', api)
