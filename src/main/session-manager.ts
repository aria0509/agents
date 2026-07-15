import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { Session, SessionState } from '../shared/types'
import type { NewSessionInput, SessionConfigPatch, SessionView } from '../shared/ipc'
import { pushRecentLaunchArgs, type AppStore } from './store'
import type { AccountManager } from './account-manager'
import { PtyManager } from './pty-manager'
import { HookServer, type HookEvent } from './hook-server'
import {
  claudePath,
  detectRateLimit,
  envFor,
  isTrustPrompt,
  moveTranscript,
  sessionArgs,
  writeSessionSettings
} from './claude-cli'

/** utilization at/above which we proactively switch before submitting */
const SWITCH_THRESHOLD = 95

interface StatuslinePayload {
  model?: { id?: string; display_name?: string }
  effort?: { level?: string }
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number }
    seven_day?: { used_percentage?: number; resets_at?: number }
  }
}

/** kinds of OS notification a session can request via the 'notify' event */
export type NotifyKind = 'attention' | 'done' | 'rate-limited'

/** Emits 'notify' ({ id, kind }) so the main process can raise an OS notification. */
export class SessionManager extends EventEmitter {
  readonly ptys = new PtyManager()
  readonly hooks: HookServer
  /** sessions awaiting a "continue" once their (re)started claude is ready */
  private pendingContinue = new Set<string>()
  /** wait-and-continue timers, keyed by session id */
  private resetTimers = new Map<string, NodeJS.Timeout>()

  constructor(
    private store: AppStore,
    private accounts: AccountManager,
    private onChange: () => void
  ) {
    super()
    this.hooks = new HookServer((sessionId) => {
      const s = this.get(sessionId)
      const name = s ? (this.accounts.get(s.accountDir)?.name ?? '') : ''
      return `◉ agents · ${name}`
    })
    this.hooks.on('event', (ev: HookEvent) => this.onHookEvent(ev))
    this.ptys.on('data', ({ id, data }: { id: string; data: string }) => this.scanOutput(id, data))
    this.ptys.on('exit', ({ id }: { id: string }) => {
      // a --resume that exits before SessionStart failed (e.g. transcript gone) → start fresh
      if (this.resuming.has(id)) return void this.resumeFailed(id)
      // an expected kill (switch/restart) clears state itself; unexpected → exited
      if (this.get(id)?.state !== 'exited') this.setState(id, 'exited')
    })
    this.ptys.on('resize', () => this.onChange())
  }

  list(): Session[] {
    return this.store.get('sessions') ?? []
  }

  /**
   * On startup, previous-run sessions come back as exited cards (a click resumes
   * them). Drop resume info for any whose transcript is gone — an idle session
   * that never exchanged a message never persisted one, so a `--resume` would
   * just fail; clearing it makes the click start fresh directly.
   */
  restoreAsExited(): void {
    this.store.set(
      'sessions',
      this.list().map((s) => ({
        ...s,
        poppedOut: false,
        state: 'exited' as const,
        ...(s.transcriptPath && !existsSync(s.transcriptPath) ? { claudeSessionId: null, transcriptPath: null } : {})
      }))
    )
  }

  get(id: string): Session | undefined {
    return this.list().find((s) => s.id === id)
  }

  views(): SessionView[] {
    return this.list().map((s) => ({
      ...s,
      alive: this.ptys.isAlive(s.id),
      ...this.ptys.size(s.id)
    }))
  }

  async create(input: NewSessionInput): Promise<string> {
    // blank account → auto-pick a logged-in one with the most headroom
    const accountDir = input.accountDir || this.accounts.pickWithHeadroom()?.configDir
    if (!accountDir) throw new Error('no logged-in account available')
    pushRecentLaunchArgs(this.store, input.launchArgs)
    const session: Session = {
      id: randomUUID(),
      title: input.title.trim() || null,
      claudeSessionId: null,
      transcriptPath: null,
      cwd: input.cwd,
      accountDir,
      limitRule: input.limitRule,
      launchArgs: input.launchArgs.trim() ? input.launchArgs.trim().split(/\s+/) : [],
      state: 'idle',
      order: Math.max(0, ...this.list().map((s) => s.order + 1)),
      poppedOut: false,
      model: null,
      effort: null
    }
    this.store.set('sessions', [...this.list(), session])
    await this.spawn(session, { resume: false })
    this.onChange()
    return session.id
  }

  async restart(id: string): Promise<void> {
    const session = this.get(id)
    if (!session || this.ptys.isAlive(id)) return
    if (session.claudeSessionId) this.resuming.add(id) // watch for a failed resume
    await this.spawn(session, { resume: true })
    this.update(id, { state: 'idle' })
  }

  /**
   * `claude --resume` exited before its SessionStart hook — the conversation is
   * gone or incompatible. Reached only from the pty 'exit' handler (so the old
   * pty is already gone); start a fresh session so the card still works.
   */
  private async resumeFailed(id: string): Promise<void> {
    this.resuming.delete(id)
    this.tail.delete(id)
    this.update(id, { claudeSessionId: null, transcriptPath: null })
    const session = this.get(id)
    if (session) await this.spawn(session, { resume: false })
  }

  remove(id: string): void {
    this.clearResetTimer(id)
    this.tail.delete(id)
    this.trusted.delete(id)
    this.resuming.delete(id)
    this.ptys.kill(id)
    this.store.set(
      'sessions',
      this.list().filter((s) => s.id !== id)
    )
    this.onChange()
  }

  updateConfig(id: string, patch: SessionConfigPatch): void {
    const p: Partial<Session> = {}
    if (patch.title !== undefined) p.title = patch.title.trim() || null
    if (patch.limitRule) p.limitRule = patch.limitRule
    if (patch.launchArgs !== undefined) {
      pushRecentLaunchArgs(this.store, patch.launchArgs)
      p.launchArgs = patch.launchArgs.trim() ? patch.launchArgs.trim().split(/\s+/) : []
    }
    this.update(id, p)
  }

  reorder(orderedIds: string[]): void {
    const order = new Map(orderedIds.map((id, i) => [id, i]))
    this.store.set(
      'sessions',
      this.list().map((s) => (order.has(s.id) ? { ...s, order: order.get(s.id)! } : s))
    )
    this.onChange()
  }

  /**
   * Move a session to another account. Only allowed when not running (README:
   * account may only change while claude is idle). Moves the transcript and
   * resumes under the new account.
   */
  async switchAccount(id: string, targetDir: string, opts: { continueAfter?: boolean } = {}): Promise<void> {
    const session = this.get(id)
    if (!session || session.accountDir === targetDir) return
    if (session.state === 'running') throw new Error('cannot switch account while running')

    await this.ptys.killAndWait(id)
    let transcriptPath = session.transcriptPath
    if (transcriptPath) {
      transcriptPath = moveTranscript(transcriptPath, session.accountDir, targetDir)
    }
    this.update(id, { accountDir: targetDir, transcriptPath, state: 'idle' })
    if (opts.continueAfter) this.pendingContinue.add(id)
    await this.spawn({ ...session, accountDir: targetDir, transcriptPath }, { resume: true })
  }

  write(id: string, data: string): void {
    this.clearFinished(id)
    this.ptys.write(id, data)
  }

  /** Submit a chat message, proactively switching first if the rule calls for it. */
  async submit(id: string, text: string): Promise<void> {
    await this.maybeSwitchBeforeSubmit(id)
    this.clearFinished(id)
    this.ptys.submit(id, text)
  }

  shutdown(): void {
    for (const t of this.resetTimers.values()) clearTimeout(t)
    this.ptys.killAll()
    this.hooks.stop()
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async spawn(session: Session, opts: { resume: boolean }): Promise<void> {
    const settingsDir = join(app.getPath('userData'), 'session-settings')
    const settingsFile = writeSessionSettings(settingsDir, session.id, this.hooks.port)
    const args = sessionArgs({
      settingsFile,
      launchArgs: session.launchArgs.join(' '),
      resumeSessionId: opts.resume ? session.claudeSessionId : null
    })
    const env = await envFor(session.accountDir)
    this.ptys.spawn(session.id, await claudePath(), args, { cwd: session.cwd, env })
  }

  /** If auto-switch and the current account is near its cap, switch first. */
  private async maybeSwitchBeforeSubmit(id: string): Promise<void> {
    const session = this.get(id)
    if (!session || session.limitRule !== 'auto-switch') return
    const account = this.accounts.get(session.accountDir)
    const used = account?.usage.fiveHour
    if (used == null || used < SWITCH_THRESHOLD) return
    const target = this.accounts.pickWithHeadroom(session.accountDir)
    if (target) await this.switchAccount(id, target.configDir, { continueAfter: false })
  }

  /** sessions whose trust prompt we've already auto-confirmed */
  private trusted = new Set<string>()
  /** sessions currently attempting a `--resume` (watch for a failed resume) */
  private resuming = new Set<string>()
  /** rolling tail of recent pty output per session (prompts can span chunks) */
  private tail = new Map<string, string>()

  private scanOutput(id: string, data: string): void {
    const session = this.get(id)
    if (!session) return
    const buf = ((this.tail.get(id) ?? '') + data).slice(-3000)
    this.tail.set(id, buf)
    // auto-confirm claude's first-run "trust this folder" prompt (pre-selected Yes)
    if (!this.trusted.has(id) && isTrustPrompt(buf)) {
      this.trusted.add(id)
      setTimeout(() => this.ptys.write(id, '\r'), 500)
    }
    if (session.state !== 'rate-limited' && detectRateLimit(buf)) void this.handleRateLimit(id)
  }

  /** React to a session hitting its usage limit per its configured rule. */
  private async handleRateLimit(id: string): Promise<void> {
    const session = this.get(id)
    if (!session) return
    this.setState(id, 'rate-limited')

    switch (session.limitRule) {
      case 'manual':
        this.emit('notify', { id, kind: 'rate-limited' })
        break
      case 'auto-switch': {
        const target = this.accounts.pickWithHeadroom(session.accountDir)
        if (target) await this.switchAccount(id, target.configDir, { continueAfter: true })
        else this.emit('notify', { id, kind: 'rate-limited' }) // nowhere to go
        break
      }
      case 'wait-and-continue':
        this.scheduleReset(id)
        break
    }
  }

  /** Wait until the account's window resets, then resume and continue. */
  private scheduleReset(id: string): void {
    const session = this.get(id)
    if (!session) return
    const resetsAt = this.accounts.get(session.accountDir)?.usage.resetsAt
    // fall back to a 5-hour window if we don't know the exact reset time
    const delay = Math.max(0, (resetsAt ?? Date.now() + 5 * 3600_000) - Date.now()) + 5_000
    this.clearResetTimer(id)
    this.resetTimers.set(
      id,
      setTimeout(() => {
        this.clearResetTimer(id)
        this.pendingContinue.add(id)
        void this.restart(id)
      }, delay)
    )
  }

  private clearResetTimer(id: string): void {
    const t = this.resetTimers.get(id)
    if (t) {
      clearTimeout(t)
      this.resetTimers.delete(id)
    }
  }

  private onHookEvent({ sessionId, event, payload }: HookEvent): void {
    const session = this.get(sessionId)
    if (!session) return
    switch (event) {
      case 'SessionStart':
        this.resuming.delete(sessionId) // resume (or fresh start) succeeded
        this.update(sessionId, {
          claudeSessionId: (payload['session_id'] as string) ?? session.claudeSessionId,
          transcriptPath: (payload['transcript_path'] as string) ?? session.transcriptPath
        })
        if (this.pendingContinue.delete(sessionId)) {
          // give the resumed TUI a moment to accept input
          setTimeout(() => this.ptys.submit(sessionId, 'continue'), 1500)
        }
        break
      case 'UserPromptSubmit':
        this.setState(sessionId, 'running')
        break
      case 'Stop':
        if (session.state !== 'done') {
          this.update(sessionId, { state: 'done' })
          this.emit('notify', { id: sessionId, kind: 'done' })
        }
        break
      case 'Notification':
        this.setState(sessionId, 'needs-attention')
        this.emit('notify', { id: sessionId, kind: 'attention' })
        break
      case 'statusline':
        this.onStatusline(session, payload as StatuslinePayload)
        break
    }
  }

  private onStatusline(session: Session, p: StatuslinePayload): void {
    const model = p.model?.display_name ?? session.model
    const effort = p.effort?.level ?? session.effort
    if (model !== session.model || effort !== session.effort) {
      this.update(session.id, { model, effort })
    }
    const rl = p.rate_limits
    if (rl?.five_hour || rl?.seven_day) {
      this.accounts.updateUsage(session.accountDir, {
        fiveHour: rl.five_hour?.used_percentage ?? null,
        weekly: rl.seven_day?.used_percentage ?? null,
        resetsAt: rl.five_hour?.resets_at ? rl.five_hour.resets_at * 1000 : null,
        weeklyResetsAt: rl.seven_day?.resets_at ? rl.seven_day.resets_at * 1000 : null
      })
    }
  }

  /** typing into a finished session brings it back to plain idle */
  private clearFinished(id: string): void {
    const s = this.get(id)
    if (s && (s.state === 'done' || s.state === 'needs-attention')) {
      this.update(id, { state: 'idle' })
    }
  }

  private setState(id: string, state: SessionState): void {
    if (this.get(id)?.state !== state) this.update(id, { state })
  }

  private update(id: string, patch: Partial<Session>): void {
    this.store.set(
      'sessions',
      this.list().map((s) => (s.id === id ? { ...s, ...patch } : s))
    )
    this.onChange()
  }
}
