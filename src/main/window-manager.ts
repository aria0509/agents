import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { EVENT_PTY_DATA, type PtyDataEvent } from '../shared/ipc'

function baseOptions(): Electron.BrowserWindowConstructorOptions {
  return {
    show: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false
    }
  }
}

/** Owns the main grid window plus one pop-out window per popped-out session. */
export class WindowManager {
  private main: BrowserWindow | null = null
  private popouts = new Map<string, BrowserWindow>()

  constructor(private onPopoutChange: (sessionId: string, poppedOut: boolean) => void) {}

  private load(win: BrowserWindow, query?: string): void {
    const url = process.env['ELECTRON_RENDERER_URL']
    if (url) {
      void win.loadURL(query ? `${url}?${query}` : url)
    } else {
      void win.loadFile(join(import.meta.dirname, '../renderer/index.html'), query ? { search: query } : undefined)
    }
    win.webContents.setWindowOpenHandler(({ url: external }) => {
      void shell.openExternal(external)
      return { action: 'deny' }
    })
    win.on('ready-to-show', () => win.show())
  }

  createMain(): BrowserWindow {
    const win = new BrowserWindow({ ...baseOptions(), width: 1440, height: 900 })
    this.load(win)
    win.on('closed', () => (this.main = null))
    this.main = win
    return win
  }

  hasMain(): boolean {
    return this.main !== null
  }

  popOut(sessionId: string): void {
    const existing = this.popouts.get(sessionId)
    if (existing) return this.focusPoppedOut(sessionId)
    // open centered on the display the user is working on (multi-monitor:
    // the cursor is where they just clicked the pop-out button)
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const width = Math.min(900, workArea.width)
    const height = Math.min(680, workArea.height)
    const win = new BrowserWindow({
      ...baseOptions(),
      width,
      height,
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2)
    })
    this.load(win, `session=${sessionId}`)
    this.popouts.set(sessionId, win)
    this.onPopoutChange(sessionId, true)
    win.on('closed', () => {
      this.popouts.delete(sessionId)
      this.onPopoutChange(sessionId, false)
    })
  }

  focusPoppedOut(sessionId: string): void {
    const win = this.popouts.get(sessionId)
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  closePopout(sessionId: string): void {
    this.popouts.get(sessionId)?.close()
  }

  /** Show the main window, recreating it if it was closed (tray/dock reopen). */
  focusMain(): void {
    if (!this.main) {
      this.createMain()
      return
    }
    if (this.main.isMinimized()) this.main.restore()
    this.main.show()
    this.main.focus()
  }

  /** Send to every window (state changes flow to pop-outs too). */
  broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
  }

  /** Pty output goes to the grid plus that session's own pop-out only. */
  sendPty(ev: PtyDataEvent): void {
    for (const win of [this.main, this.popouts.get(ev.id)]) {
      if (win && !win.isDestroyed()) win.webContents.send(EVENT_PTY_DATA, ev)
    }
  }

  /** Send to the main window — after it has loaded and mounted when focusMain()
   *  just recreated it (a notification click with the window closed). */
  sendToMain(channel: string, payload: unknown): void {
    const win = this.main
    if (!win) return
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => setTimeout(() => !win.isDestroyed() && win.webContents.send(channel, payload), 300))
    } else win.webContents.send(channel, payload)
  }

  anyFocused(): boolean {
    return BrowserWindow.getAllWindows().some((w) => w.isFocused())
  }
}
