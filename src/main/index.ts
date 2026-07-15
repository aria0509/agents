import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, Tray } from 'electron'
import { writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  EVENT_FOCUS_SESSION,
  EVENT_OPEN_SETTINGS,
  EVENT_PTY_DATA,
  EVENT_STATE,
  ipcChannel,
  type AppState,
  type NewAccountInput,
  type NewSessionInput,
  type SessionConfigPatch
} from '../shared/ipc'
import { createStore } from './store'
import { AccountManager } from './account-manager'
import { SessionManager, type NotifyKind } from './session-manager'
import { WindowManager } from './window-manager'

// Persist under the user's home dir (~/.agent-s); a separate dev copy so a dev
// run never touches real data.
app.setPath('userData', join(homedir(), app.isPackaged ? '.agent-s' : '.agent-s-dev'))

const NOTIFY_TEXT: Record<string, Record<NotifyKind, string>> = {
  'zh-Hant': { attention: '需要處理', done: '任務完成', 'rate-limited': '已達限額' },
  'zh-Hans': { attention: '需要处理', done: '任务完成', 'rate-limited': '已达限额' },
  en: { attention: 'Needs attention', done: 'Task done', 'rate-limited': 'Rate limited' }
}
const QUIT_TEXT: Record<
  string,
  { message: string; detail: string; bg: string; quit: string; cancel: string; tray: string; settings: string }
> = {
  'zh-Hant': {
    message: '要讓 Claude 在背景繼續執行嗎？',
    detail: '選「背景執行」會關閉視窗但保留執行中的 session，下次打開直接恢復。',
    bg: '背景執行',
    quit: '結束',
    cancel: '取消',
    tray: '打開主視窗',
    settings: '設定…'
  },
  'zh-Hans': {
    message: '要让 Claude 在后台继续运行吗？',
    detail: '选“后台运行”会关闭窗口但保留运行中的 session，下次打开直接恢复。',
    bg: '后台运行',
    quit: '退出',
    cancel: '取消',
    tray: '打开主窗口',
    settings: '设置…'
  },
  en: {
    message: 'Keep Claude running in the background?',
    detail: 'Background keeps running sessions alive with the windows closed; reopening restores them.',
    bg: 'Background',
    quit: 'Quit',
    cancel: 'Cancel',
    tray: 'Open main window',
    settings: 'Settings…'
  }
}
function locale<T>(table: Record<string, T>): T {
  const l = app.getLocale()
  if (l.startsWith('zh')) return /TW|HK|MO|Hant/i.test(l) ? table['zh-Hant'] : table['zh-Hans']
  return table['en']
}

function dirLabel(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() ?? cwd
}

const iconPath = (): string => join(app.getAppPath(), 'assets', 'icon.png')

function bootstrap(): void {
  const store = createStore()

  const windows = new WindowManager((sessionId, poppedOut) => {
    store.set(
      'sessions',
      store.get('sessions').map((s) => (s.id === sessionId ? { ...s, poppedOut } : s))
    )
    notify()
  })

  let pending = false
  const notify = (): void => {
    if (pending) return
    pending = true
    queueMicrotask(() => {
      pending = false
      windows.broadcast(EVENT_STATE, state())
    })
  }

  const accounts = new AccountManager(store, notify)
  const sessions = new SessionManager(store, accounts, notify)
  const state = (): AppState => ({
    accounts: accounts.list(),
    sessions: sessions.views(),
    recentLaunchArgs: store.get('recentLaunchArgs') ?? []
  })

  sessions.ptys.on('data', (ev) => windows.broadcast(EVENT_PTY_DATA, ev))

  sessions.on('notify', ({ id, kind }: { id: string; kind: NotifyKind }) => {
    if (kind === 'done' && windows.anyFocused()) return
    if (!Notification.isSupported()) return
    const session = sessions.get(id)
    if (!session) return
    const n = new Notification({
      title: locale(NOTIFY_TEXT)[kind],
      body: `${session.title ?? dirLabel(session.cwd)} · ${accounts.get(session.accountDir)?.name ?? ''}`
    })
    n.on('click', () => {
      if (session.poppedOut) windows.focusPoppedOut(id)
      else {
        windows.focusMain()
        windows.sendToMain(EVENT_FOCUS_SESSION, id)
      }
    })
    n.show()
  })

  void sessions.hooks.start()
  // stored sessions from a previous run come back as exited cards (click resumes them)
  sessions.restoreAsExited()

  // refresh auth + usage for every account (usage via the oauth endpoint using
  // each account's Keychain/file token) — non-blocking
  void accounts.refreshAllAuth()

  // app/dock icon (packaging uses assets/icon.png too; this covers dev)
  const appIcon = nativeImage.createFromPath(iconPath())
  if (!appIcon.isEmpty()) app.dock?.setIcon(appIcon)

  // menu-bar presence so the app can be reopened after all windows close
  const trayImg = appIcon.isEmpty() ? appIcon : appIcon.resize({ width: 18, height: 18 })
  const tray = new Tray(trayImg)
  tray.setToolTip('Agent S')
  // clicking the icon shows this menu; only "open main window" opens the window
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: locale(QUIT_TEXT).tray, click: () => windows.focusMain() },
      { type: 'separator' },
      { role: 'quit' }
    ])
  )

  // minimal app menu: Settings (⌘,) + Edit (so copy/paste works in inputs) + Quit
  const openSettings = (): void => {
    windows.focusMain()
    windows.sendToMain(EVENT_OPEN_SETTINGS, undefined)
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Agent S',
        submenu: [
          { label: locale(QUIT_TEXT).settings, accelerator: 'CmdOrCtrl+,', click: openSettings },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      { role: 'editMenu' }
    ])
  )

  const handle = (method: Parameters<typeof ipcChannel>[0], fn: (...args: never[]) => unknown): void => {
    ipcMain.handle(ipcChannel(method), (_e, ...args) => fn(...(args as never[])))
  }

  handle('getAppInfo', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform
  }))
  handle('getState', () => state())
  handle('pickDirectory', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  handle('discoverAccounts', () => accounts.discover())
  handle('registerAccount', (input: NewAccountInput) => accounts.register(input))
  handle('updateAccountNote', (dir: string, note: string) => accounts.updateNote(dir, note))
  handle('refreshAuth', (dir: string) => accounts.refreshAuth(dir))
  handle('refreshAllUsage', () => accounts.refreshAllUsage())
  handle('startLogin', (dir: string) => accounts.startLogin(dir))
  handle('submitLoginCode', (dir: string, code: string) => accounts.submitLoginCode(dir, code))
  handle('cancelLogin', (dir: string) => accounts.cancelLogin(dir))
  handle('removeAccount', (dir: string) => {
    if (sessions.list().some((s) => s.accountDir === dir)) throw new Error('account is in use by a session')
    accounts.remove(dir)
  })

  handle('createSession', (input: NewSessionInput) => sessions.create(input))
  handle('restartSession', (id: string) => sessions.restart(id))
  handle('removeSession', (id: string) => {
    windows.closePopout(id)
    sessions.remove(id)
  })
  handle('switchAccount', (id: string, dir: string) => sessions.switchAccount(id, dir))
  handle('updateSessionConfig', (id: string, patch: SessionConfigPatch) => sessions.updateConfig(id, patch))
  handle('reorderSessions', (ids: string[]) => sessions.reorder(ids))
  handle('savePastedImage', (bytes: Uint8Array, ext: string) => {
    const dir = join(app.getPath('userData'), 'paste-images')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${randomUUID()}.${ext}`)
    writeFileSync(file, Buffer.from(bytes))
    return file
  })
  handle('ptyWrite', (id: string, data: string) => sessions.write(id, data))
  handle('ptySubmit', (id: string, text: string) => sessions.submit(id, text))
  handle('ptyResize', (id: string, cols: number, rows: number) => sessions.ptys.resize(id, cols, rows))
  handle('ptySnapshot', (id: string) => sessions.ptys.snapshot(id))

  handle('popOutSession', (id: string) => windows.popOut(id))
  handle('focusPoppedOut', (id: string) => windows.focusPoppedOut(id))

  // Quit flow: offer to keep running in the background when sessions are alive.
  let quitting = false
  const shutdownAll = (): void => {
    sessions.shutdown()
    accounts.shutdown()
  }
  app.on('before-quit', (e) => {
    if (quitting) return shutdownAll()
    const hasAlive = sessions.list().some((s) => sessions.ptys.isAlive(s.id))
    if (!hasAlive) {
      quitting = true
      return shutdownAll()
    }
    const t = locale(QUIT_TEXT)
    const choice = dialog.showMessageBoxSync({
      type: 'question',
      buttons: [t.bg, t.quit, t.cancel],
      defaultId: 0,
      cancelId: 2,
      message: t.message,
      detail: t.detail
    })
    if (choice === 0) {
      e.preventDefault()
      for (const w of BrowserWindow.getAllWindows()) w.close() // keep app + ptys alive
    } else if (choice === 1) {
      quitting = true
      shutdownAll()
    } else {
      e.preventDefault()
    }
  })

  windows.createMain()
  app.on('activate', () => {
    if (!windows.hasMain()) windows.createMain()
  })
}

// a single instance owns the store; a second launch just focuses the first
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  app.whenReady().then(bootstrap)
}

// keep running with no windows (mac): sessions stay alive, tray reopens the app
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
