import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { AccountUsage, Session, SessionState } from '../shared/types'
import type { NewSessionInput, SessionConfigPatch, SessionView } from '../shared/ipc'
import { pushRecentLaunchArgs, type AppStore } from './store'
import type { AccountManager } from './account-manager'
import { PtyManager } from './pty-manager'
import { HookServer, type HookEvent } from './hook-server'
import {
  claudePath,
  detectPermissionMode,
  detectRateLimit,
  detectUltracode,
  envFor,
  isTrustPrompt,
  isTuiReady,
  moveTranscript,
  parseSettingsOverrides,
  readSystemPrompt,
  sessionArgs,
  writeSessionSettings
} from './claude-cli'

/** utilization at/above which we proactively switch before submitting */
const SWITCH_THRESHOLD = 95

/** SGR + legacy mouse reports and focus in/out — terminal chatter, not typing */
const MOUSE_OR_FOCUS = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[[IO]/g
/** xterm's automatic replies to claude's queries — cursor position (CPR), device
 *  attributes (DA1/DA2), status (DSR), mode reports (DECRPM), DCS and OSC
 *  responses. These flow through the same renderer onData→write path as typing;
 *  treating them as keystrokes abandoned queued sends and cleared done badges
 *  (live-hit: the interrupted-resume screen queries constantly, so every queued
 *  submission got dropped before delivery). */
const TERMINAL_REPLIES = /\x1b\[\d+;\d+R|\x1b\[[?>][\d;]*c|\x1b\[\d*n|\x1b\[\?\d+;\d+\$y|\x1bP[^\x1b]*\x1b\\|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g

/** True if a pty write carries real keyboard input rather than mouse/focus
 *  chatter or the terminal answering claude's state queries. */
function isKeyboardInput(data: string): boolean {
  return data.replace(MOUSE_OR_FOCUS, '').replace(TERMINAL_REPLIES, '').length > 0
}

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
  /** sessions to put back into ultracode once their (re)started claude is ready —
   *  the CLI flag is session-only and never survives a new process */
  private pendingUltracode = new Set<string>()
  /** sessions whose TUI has rendered its input box since the last spawn — the
   *  gate for delivering queued submissions (see send()) */
  private tuiReady = new Set<string>()
  /** submissions queued per session until the TUI is ready; drained FIFO with
   *  an ack step between items */
  private sendQueue = new Map<string, string[]>()
  /** sessions with a submission currently awaiting its ack */
  private sending = new Set<string>()
  /** per-session ack-verify timers, cancelled on kill/respawn */
  private verifyTimers = new Map<string, NodeJS.Timeout>()
  /** per-spawn fallback that force-opens the ready gate if the footer never matches */
  private readyFallbacks = new Map<string, NodeJS.Timeout>()
  /** wait-and-continue timers, keyed by session id */
  private resetTimers = new Map<string, NodeJS.Timeout>()
  /** true during shutdown so pty exits don't rewrite state to 'exited' — we keep
   *  each session's pre-quit state so the next launch knows which were active */
  private shuttingDown = false
  /** ids of sessions that were active (had a live pty) at the previous quit */
  private restoredActiveIds: string[] = []

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
      if (this.shuttingDown) return // quitting: preserve state so restore knows what was active
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
   * them). Records which were active (non-exited = had a live pty last time) so the
   * caller can offer to restore just those, and returns that count. Drops resume
   * info for any whose transcript is gone — an idle session that never exchanged a
   * message never persisted one, so a `--resume` would fail; clearing it makes the
   * click/restore start fresh directly.
   */
  restoreAsExited(): number {
    const prev = this.list()
    this.restoredActiveIds = prev.filter((s) => s.state !== 'exited').map((s) => s.id)
    this.store.set(
      'sessions',
      prev.map((s) => ({
        ...s,
        // fields added after a session was persisted arrive undefined — fill
        // them once here so every later read/compare can trust the shape
        systemPromptFiles: s.systemPromptFiles ?? [],
        addDirs: s.addDirs ?? [],
        addDirClaudeMd: s.addDirClaudeMd ?? false,
        settingsJson: s.settingsJson ?? '',
        poppedOut: false,
        state: 'exited' as const,
        ...(s.transcriptPath && !existsSync(s.transcriptPath) ? { claudeSessionId: null, transcriptPath: null } : {})
      }))
    )
    return this.restoredActiveIds.length
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
      effort: input.effort,
      modelId: input.modelId,
      mode: input.mode,
      systemPromptFiles: input.systemPromptFiles,
      addDirs: input.addDirs,
      addDirClaudeMd: input.addDirClaudeMd,
      settingsJson: input.settingsJson,
      draft: null
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
   * Stop a running session without removing it — kill claude so the card becomes
   * "exited — click to resume", keeping its record + transcript for later resume.
   */
  stop(id: string): void {
    this.clearResetTimer(id)
    this.clearSends(id)
    this.pendingContinue.delete(id)
    this.pendingUltracode.delete(id)
    // a stop during a --resume boot must read as a stop, not a failed resume
    // (else the exit handler wipes resume info and respawns a fresh session)
    this.resuming.delete(id)
    this.ptys.kill(id) // exit handler (id not in `resuming`) marks it exited
  }

  /** Resume the sessions that were active at the last quit — the "restore last time?" action. */
  async restoreActive(): Promise<void> {
    await Promise.all(this.restoredActiveIds.map((id) => this.restart(id))) // restart no-ops on the already-alive
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
    this.pendingContinue.delete(id)
    this.pendingUltracode.delete(id)
    this.clearSends(id)
    this.ptys.kill(id)
    this.ptys.forget(id)
    this.store.set(
      'sessions',
      this.list().filter((s) => s.id !== id)
    )
    this.onChange()
  }

  async updateConfig(id: string, patch: SessionConfigPatch): Promise<void> {
    const session = this.get(id)
    if (!session) return
    const p: Partial<Session> = {}
    if (patch.title !== undefined) p.title = patch.title.trim() || null
    if (patch.limitRule) p.limitRule = patch.limitRule
    if (patch.launchArgs !== undefined) {
      pushRecentLaunchArgs(this.store, patch.launchArgs)
      p.launchArgs = patch.launchArgs.trim() ? patch.launchArgs.trim().split(/\s+/) : []
    }
    if (patch.modelId !== undefined) p.modelId = patch.modelId
    if (patch.effort !== undefined) p.effort = patch.effort
    if (patch.mode !== undefined) p.mode = patch.mode
    if (patch.systemPromptFiles !== undefined) p.systemPromptFiles = patch.systemPromptFiles
    if (patch.addDirs !== undefined) p.addDirs = patch.addDirs
    if (patch.addDirClaudeMd !== undefined) p.addDirClaudeMd = patch.addDirClaudeMd
    if (patch.settingsJson !== undefined) p.settingsJson = patch.settingsJson
    // these are all launch flags — respawn a live (idle) session so the
    // change applies now; a running one keeps its turn and picks them up on the
    // next restart. Kill BEFORE writing the new values: the dying process's
    // last output frames still run the footer/statusline sync, which would
    // overwrite the user's choice with the old mode (live-hit in e2e).
    const launchKeys = ['modelId', 'effort', 'mode', 'systemPromptFiles', 'addDirs', 'addDirClaudeMd', 'settingsJson'] as const
    const respawn =
      launchKeys.some((k) => patch[k] !== undefined && JSON.stringify(patch[k]) !== JSON.stringify(session[k])) &&
      this.ptys.isAlive(id) &&
      session.state !== 'running'
    if (respawn) {
      await this.ptys.killAndWait(id)
      this.tail.delete(id)
    }
    this.update(id, p)
    if (respawn) {
      if (this.get(id)?.claudeSessionId) this.resuming.add(id)
      const fresh = this.get(id)
      if (fresh) await this.spawn(fresh, { resume: !!fresh.claudeSessionId })
      this.update(id, { state: 'idle' })
    }
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
    // the target account hasn't trusted this folder yet — reset so its own
    // "trust this folder" prompt gets auto-confirmed (trusted is per-session and
    // would otherwise still be set from the previous account). tail too, so stale
    // output doesn't confuse prompt detection.
    this.trusted.delete(id)
    this.tail.delete(id)
    // Only resume if there's actually a transcript to resume. A session whose
    // transcript is gone (never messaged, or already cleaned up) must start FRESH
    // under the new account — otherwise `claude --resume` dies with "No
    // conversation found" and the card is stuck.
    const canResume = !!session.claudeSessionId && !!session.transcriptPath && existsSync(session.transcriptPath)
    const transcriptPath = canResume ? moveTranscript(session.transcriptPath!, session.accountDir, targetDir) : null
    this.update(id, {
      accountDir: targetDir,
      transcriptPath,
      claudeSessionId: canResume ? session.claudeSessionId : null,
      state: 'idle'
    })
    // a session stopped by its usage limit resumes work by default after any
    // switch — including a manual one from the account picker
    if (opts.continueAfter ?? session.state === 'rate-limited') this.pendingContinue.add(id)
    if (canResume) this.resuming.add(id) // fall back to fresh if the resume still fails
    await this.spawn(this.get(id)!, { resume: canResume })
  }

  write(id: string, data: string): void {
    // clicking/scrolling a mouse-tracking terminal (claude's pinned mode) writes
    // mouse/focus reports — those aren't the user re-engaging, so they must not
    // clear a done/needs-attention badge just because the user glanced at the card
    if (isKeyboardInput(data)) {
      this.clearFinished(id)
      // the user is typing in the terminal — abandon queued auto-submits and any
      // pending Enter retry, or a retry would fire their half-typed line (live-hit
      // on the interrupted-resume "What should Claude do instead?" prompt)
      this.abandonSends(id)
    }
    this.ptys.write(id, data)
  }

  /** Persist the chat-input draft. Deliberately no notify(): this runs per
   *  keystroke (debounced) and renderers own their live copy — the value only
   *  matters for hydration after an app restart. */
  saveDraft(id: string, text: string): void {
    this.store.set(
      'sessions',
      this.list().map((s) => (s.id === id ? { ...s, draft: text || null } : s))
    )
  }

  /** Submit a chat message, proactively switching first if the rule calls for it.
   *  Goes through the send queue: instant when claude is up, held until the TUI
   *  is ready when a switch just respawned it. */
  async submit(id: string, text: string): Promise<void> {
    await this.maybeSwitchBeforeSubmit(id)
    this.clearFinished(id)
    this.send(id, text)
  }

  shutdown(): void {
    this.shuttingDown = true // pty exits below must not rewrite state (keep what was active)
    for (const t of this.resetTimers.values()) clearTimeout(t)
    this.ptys.killAll()
    this.hooks.stop()
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async spawn(session: Session, opts: { resume: boolean }): Promise<void> {
    // ultracode is session-only in the CLI — a fresh process starts without it —
    // and the dead process's tail must not leak detections into this one.
    // Remember the intent and re-apply once the new process is ready; the label
    // must still reset now so a failed re-apply can't leave it lying.
    this.tail.delete(session.id)
    this.clearSends(session.id) // queued submits from a prior incarnation must not fire into this one
    if (session.effort === 'ultracode') {
      this.pendingUltracode.add(session.id)
      this.update(session.id, { effort: null })
    }
    const settingsDir = join(app.getPath('userData'), 'session-settings')
    const settingsFile = writeSessionSettings(
      settingsDir,
      session.id,
      this.hooks.port,
      parseSettingsOverrides(session.settingsJson ?? '')
    )
    const args = sessionArgs({
      settingsFile,
      launchArgs: session.launchArgs.join(' '),
      resumeSessionId: opts.resume ? session.claudeSessionId : null,
      model: session.modelId,
      // ultracode was just converted to pendingUltracode above — pass the base level
      effort: session.effort === 'ultracode' ? null : session.effort,
      permissionMode: session.mode,
      addDirs: session.addDirs ?? [],
      appendSystemPrompt: readSystemPrompt(session.systemPromptFiles ?? [])
    })
    const env = await envFor(session.accountDir)
    // Pinned input box + captured wheel scrolling (claude's alt-screen TUI) is
    // env/settings/statsig-gated, not terminal-detected — force it on so every
    // session scrolls content with the footer fixed, like claude in iTerm2.
    env['CLAUDE_CODE_NO_FLICKER'] = '1'
    // claude identifies xterm.js via an XTVERSION reply (which use-terminal
    // provides) — do NOT spoof TERM_PROGRAM=vscode for this: claude then tries
    // to auto-install its VS Code extension and surfaces an install error.
    // Hard-off auto IDE connect too: a stored autoConnectIde setting (from the
    // user's real IDE usage) would otherwise trigger the same failed install.
    env['CLAUDE_CODE_AUTO_CONNECT_IDE'] = 'false'
    if (session.addDirClaudeMd) env['CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD'] = '1'
    this.ptys.spawn(session.id, await claudePath(), args, { cwd: session.cwd, env })
  }

  /** If auto-switch and any of the account's limit windows is near its cap,
   *  switch first rather than burning the submit on a doomed account. */
  private async maybeSwitchBeforeSubmit(id: string): Promise<void> {
    const session = this.get(id)
    if (!session || session.limitRule !== 'auto-switch') return
    const account = this.accounts.get(session.accountDir)
    if (!account || this.accounts.worstUsedPct(account) < SWITCH_THRESHOLD) return
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
    // scan the WHOLE (tail + data): pty output is coalesced up to 64KB/chunk, so
    // slicing to 3000 before scanning would blind us to a draw-once signal (the
    // ✦ ultracode banner) buried in the middle of a big --resume replay chunk.
    // Only the retained tail is capped (3000 is enough to bridge a split token).
    const buf = (this.tail.get(id) ?? '') + data
    this.tail.set(id, buf.slice(-3000))
    // auto-confirm claude's first-run "trust this folder" prompt (pre-selected Yes)
    if (!this.trusted.has(id) && isTrustPrompt(buf)) {
      this.trusted.add(id)
      setTimeout(() => this.ptys.write(id, '\r'), 500)
    }
    // input box is up — queued submissions may now actually land
    if (!this.tuiReady.has(id) && isTuiReady(buf)) {
      this.tuiReady.add(id)
      this.drain(id)
    }
    // ultracode only — the statusline syncs every plain level itself
    const uc = detectUltracode(buf)
    if (uc === true && session.effort !== 'ultracode') {
      this.update(id, { effort: 'ultracode' })
    } else if (uc === false && session.effort === 'ultracode') {
      this.update(id, { effort: null }) // next statusline fills the real level
    }
    // permission mode changed in the TUI (shift+tab) — sync it so the next
    // respawn restores it (the statusline payload doesn't carry it)
    const mode = detectPermissionMode(buf)
    if (mode && mode !== session.mode) this.update(id, { mode })
    if (session.state !== 'rate-limited' && detectRateLimit(buf)) void this.handleRateLimit(id)
  }

  /** React to a session hitting its usage limit per its configured rule. */
  private async handleRateLimit(id: string): Promise<void> {
    const session = this.get(id)
    if (!session) return
    this.setState(id, 'rate-limited')
    // the banner is ground truth — keep this account out of the rotation until
    // its window resets (and probe its real numbers in the background)
    this.accounts.markRateLimited(session.accountDir)

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
        // restore ultracode before any queued "continue" runs a turn on it
        if (this.pendingUltracode.delete(sessionId)) this.send(sessionId, '/effort ultracode')
        if (this.pendingContinue.delete(sessionId)) this.send(sessionId, 'continue')
        break
      case 'UserPromptSubmit':
        this.setState(sessionId, 'running')
        break
      case 'Stop':
        // Stop fires at every turn boundary, including the wake-ups background
        // tasks/agents trigger when they finish. The payload lists still-running
        // backgrounded work — the SESSION is only done once none remains.
        if ((payload['background_tasks'] as unknown[] | undefined)?.length) break
        // a limit banner also ends the turn — don't repaint rate-limited as done
        if (session.state === 'rate-limited') break
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
    // a killed process's in-flight statusline POST can land after a respawn
    // began — it must not overwrite freshly-configured model/effort values
    if (!this.ptys.isAlive(session.id)) return
    const model = p.model?.display_name ?? session.model
    const modelId = p.model?.id ?? session.modelId
    // ultracode reports as plain xhigh here (scanOutput sets/clears the label)
    const level = p.effort?.level ?? session.effort
    const effort = session.effort === 'ultracode' && level === 'xhigh' ? 'ultracode' : level
    if (model !== session.model || effort !== session.effort || modelId !== session.modelId) {
      this.update(session.id, { model, effort, modelId })
    }
    // both windows are optional in the payload — patch only what's present, so
    // a five_hour-only event can't wipe the weekly numbers (or vice versa)
    const rl = p.rate_limits
    const u: Partial<AccountUsage> = {}
    if (rl?.five_hour) {
      u.fiveHour = rl.five_hour.used_percentage ?? null
      u.resetsAt = rl.five_hour.resets_at ? rl.five_hour.resets_at * 1000 : null
    }
    if (rl?.seven_day) {
      u.weekly = rl.seven_day.used_percentage ?? null
      u.weeklyResetsAt = rl.seven_day.resets_at ? rl.seven_day.resets_at * 1000 : null
    }
    if (Object.keys(u).length) this.accounts.updateUsage(session.accountDir, u)
  }

  /**
   * Queue a submission (user text, "continue", "/effort ultracode") and deliver
   * it once the TUI can actually take it. Two failure modes this absorbs, both
   * seen live around account switches:
   * - a paste into a claude still replaying a resumed transcript lands in the
   *   input box but the trailing Enter gets eaten → gate on isTuiReady;
   * - even then a submission can silently not register → after sending, expect
   *   claude's UserPromptSubmit ack (state → running) and re-press Enter a few
   *   times if it never comes (the text already sits in the input box). Local
   *   slash commands never ack, so the timeout advances the queue either way.
   */
  private send(id: string, text: string): void {
    const q = this.sendQueue.get(id) ?? []
    q.push(text)
    this.sendQueue.set(id, q)
    this.drain(id)
  }

  private drain(id: string): void {
    if (this.sending.has(id)) return
    if (!this.tuiReady.has(id)) {
      // the footer regex is wording-sensitive — if it never matches (e.g. the
      // interrupted-resume prompt, or a future CLI change), queued text must not
      // be stuck forever: force-open the gate after a generous boot window
      if (!this.readyFallbacks.has(id) && this.ptys.isAlive(id) && this.sendQueue.get(id)?.length) {
        this.readyFallbacks.set(
          id,
          setTimeout(() => {
            this.readyFallbacks.delete(id)
            if (this.ptys.isAlive(id) && !this.tuiReady.has(id)) {
              this.tuiReady.add(id)
              this.drain(id)
            }
          }, 15_000)
        )
      }
      return
    }
    const text = this.sendQueue.get(id)?.shift()
    if (text === undefined) return
    this.sending.add(id)
    this.ptys.submit(id, text)
    // local slash commands never ack via UserPromptSubmit — don't re-press Enter
    // for them (a retry can only collide with whatever the user types next)
    const maxRetries = text.startsWith('/') ? 0 : 3
    let retries = 0
    const timer = setInterval(() => {
      const state = this.get(id)?.state
      const acked = state === 'running' || state === 'done' || state === 'needs-attention'
      if (acked || !this.ptys.isAlive(id) || retries >= maxRetries) {
        clearInterval(timer)
        this.verifyTimers.delete(id)
        this.sending.delete(id)
        if (this.ptys.isAlive(id)) this.drain(id)
        return
      }
      retries++
      this.ptys.write(id, '\r') // the text already sits in the input box
    }, 2000)
    this.verifyTimers.set(id, timer)
  }

  /** Drop queued/in-flight submissions (user took over, or nothing should land). */
  private abandonSends(id: string): void {
    const t = this.verifyTimers.get(id)
    if (t) clearInterval(t)
    this.verifyTimers.delete(id)
    this.sendQueue.delete(id)
    this.sending.delete(id)
  }

  /** Full reset on kill/respawn — leftovers must never reach the NEXT process. */
  private clearSends(id: string): void {
    this.abandonSends(id)
    const f = this.readyFallbacks.get(id)
    if (f) clearTimeout(f)
    this.readyFallbacks.delete(id)
    this.tuiReady.delete(id)
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
