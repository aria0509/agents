/**
 * Typed IPC contract between main and renderer.
 * Every channel is declared here once; both sides import from this file.
 */
import type { Account, LimitRule, Session } from './types'

/** editable-after-creation session config (README: "後期隨時可以改") */
export interface SessionConfigPatch {
  title?: string
  limitRule?: LimitRule
  launchArgs?: string
}

/** account fields the user can register/edit */
export interface NewAccountInput {
  name: string
  /** empty → defaults to ~/.claude-<name> */
  path: string
  note: string
}

/** Runtime view of a session (persisted fields + live pty info). */
export interface SessionView extends Session {
  /** pty process is alive */
  alive: boolean
  cols: number
  rows: number
}

export interface AppState {
  accounts: Account[]
  sessions: SessionView[]
  /** recently used launch-args strings, most-recent first (max 10) */
  recentLaunchArgs: string[]
}

export interface NewSessionInput {
  cwd: string
  /** empty → auto-pick a logged-in account with the most headroom */
  accountDir: string
  title: string
  limitRule: LimitRule
  /** raw CLI args string, split on whitespace */
  launchArgs: string
}

export interface PtyDataEvent {
  id: string
  data: string
  /** cumulative output length after this chunk — used to dedupe vs snapshot */
  end: number
}

export interface PtySnapshot {
  data: string
  end: number
}

/** invoke-style API (renderer → main) plus event subscriptions (main → renderer) */
export interface IpcApi {
  getAppInfo(): Promise<{ version: string; electron: string; platform: string }>
  getState(): Promise<AppState>
  pickDirectory(): Promise<string | null>

  // accounts
  discoverAccounts(): Promise<void>
  registerAccount(input: NewAccountInput): Promise<void>
  updateAccountNote(configDir: string, note: string): Promise<void>
  /** re-check auth and (best-effort) refresh usage for one account */
  refreshAuth(configDir: string): Promise<void>
  /** refresh usage for all logged-in accounts (may prompt for Keychain access) */
  refreshAllUsage(): Promise<void>
  /** start OAuth login; resolves with the sign-in URL to show (browser also opens) */
  startLogin(configDir: string): Promise<string>
  /** submit the pasted code; resolves true once the account is logged in */
  submitLoginCode(configDir: string, code: string): Promise<boolean>
  /** abort an in-progress login (dialog closed) */
  cancelLogin(configDir: string): Promise<void>
  removeAccount(configDir: string): Promise<void>

  // sessions
  createSession(input: NewSessionInput): Promise<string>
  restartSession(id: string): Promise<void>
  removeSession(id: string): Promise<void>
  /** move the session to another account (only when idle): move transcript + resume */
  switchAccount(id: string, targetAccountDir: string): Promise<void>
  updateSessionConfig(id: string, patch: SessionConfigPatch): Promise<void>
  reorderSessions(orderedIds: string[]): Promise<void>
  /** save an image blob to a temp file, return its path (for chat paste) */
  savePastedImage(bytes: Uint8Array, ext: string): Promise<string>
  ptyWrite(id: string, data: string): Promise<void>
  /** submit a chat message (bracketed paste + Enter) */
  ptySubmit(id: string, text: string): Promise<void>
  ptyResize(id: string, cols: number, rows: number): Promise<void>
  ptySnapshot(id: string): Promise<PtySnapshot>

  // windowing
  popOutSession(id: string): Promise<void>
  focusPoppedOut(id: string): Promise<void>

  /**
   * A file drop, resolved in the preload (where webUtils works). `sessionId` is
   * the card the file was dropped on (from its data-session-id), or null.
   */
  onFileDrop(cb: (drop: { sessionId: string | null; paths: string[] }) => void): () => void

  // events; all return an unsubscribe fn
  onStateChanged(cb: (state: AppState) => void): () => void
  onPtyData(cb: (ev: PtyDataEvent) => void): () => void
  /** main asks the renderer to focus a session (notification click) */
  onFocusSession(cb: (id: string) => void): () => void
  /** main asks the renderer to open Settings (menu ⌘,) */
  onOpenSettings(cb: () => void): () => void
}

export const INVOKE_CHANNELS = [
  'getAppInfo',
  'getState',
  'pickDirectory',
  'discoverAccounts',
  'registerAccount',
  'updateAccountNote',
  'refreshAuth',
  'refreshAllUsage',
  'startLogin',
  'submitLoginCode',
  'cancelLogin',
  'removeAccount',
  'createSession',
  'restartSession',
  'removeSession',
  'switchAccount',
  'updateSessionConfig',
  'reorderSessions',
  'savePastedImage',
  'ptyWrite',
  'ptySubmit',
  'ptyResize',
  'ptySnapshot',
  'popOutSession',
  'focusPoppedOut'
] as const

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number]

export const EVENT_STATE = 'ev:state'
export const EVENT_PTY_DATA = 'ev:ptyData'
export const EVENT_FOCUS_SESSION = 'ev:focusSession'
export const EVENT_OPEN_SETTINGS = 'ev:openSettings'

export const ipcChannel = (method: InvokeChannel): string => `app:${method}`

declare global {
  interface Window {
    api: IpcApi
  }
}
