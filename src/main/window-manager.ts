import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'

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
    const win = new BrowserWindow({ ...baseOptions(), width: 900, height: 680 })
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

  /** Send to every window (state/pty streams flow to pop-outs too). */
  broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
  }

  sendToMain(channel: string, payload: unknown): void {
    this.main?.webContents.send(channel, payload)
  }

  anyFocused(): boolean {
    return BrowserWindow.getAllWindows().some((w) => w.isFocused())
  }
}
