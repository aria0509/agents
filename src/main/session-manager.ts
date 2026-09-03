import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { AccountUsage, Session, SessionState } from '../shared/types'
import type { NewSessionInput, SessionConfigPatch, SessionView } from '../shared/ipc'
import { pushRecentLaunchArgs, type AppStore } from './store'
import { HEADROOM_PCT, modelFamily, type AccountManager } from './account-manager'
import type { PtyManager } from './pty-manager'
import { HookServer, type HookEvent } from './hook-server'
import {
  claudePath,
  detectPermissionMode,
  detectRateLimit,
  detectUltracode,
  envFor,
  isBypassWarning,
  isInterruptNotice,
  isLoginPrompt,
  isTrustPrompt,
  linkSessionRegistry,
  moveTranscript,
  parseSettingsOverrides,
  preselectsExit,
  readSystemPrompt,
  sessionArgs,
  stripAnsi,
  tuiInputState,
  unbridgeTranscript,
  writeSessionSettings
} from './claude-cli'

/** background_tasks entries whose completion wakes the session (a task
 *  notification prompt → another turn), so a Stop with one of them running is
 *  a pause, not the end. Shell and MCP tasks don't count (mirrors the CLI's own
 *  wait set): a dev server left running would otherwise pin the card on
 *  "running" for good. ⚠️ `type` is the CLI's FRIENDLY label (verified 2.1.259:
 *  local_agent → "subagent", local_workflow → "workflow", in_process_teammate →
 *  "teammate", remote_agent → "cloud session"); the raw discriminants are kept
 *  as fallbacks since unknown types fall through to them. Matching the raw
 *  names alone never hit — a card went "done" while its subagent still ran. */
const WAKING_TASK_TYPES = new Set([
  'subagent',
  'workflow',
  'teammate',
  'cloud session',
  'local_agent',
  'local_workflow',
  'in_process_teammate',
  'remote_agent'
])
/** Notification hook types that mean the TUI is waiting on the user. Others:
 *  idle_prompt (claude has been sitting at the prompt), auth_success,
 *  agent_completed (Stop covers it), push_notification (relayed as-is). */
const ATTENTION_NOTIFICATIONS = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
  'worker_permission_prompt'
])
/** how long a statusline model mismatch may wait for a user-initiated
 *  PostModelSwitch to explain it before it counts as an automatic fallback */
const FALLBACK_GRACE_MS = 2000

/** same model ignoring the 1M-context suffix (`claude-opus-5` vs `claude-opus-5[1m]`) */
const sameModel = (a: string, b: string): boolean => a.replace(/\[.*$/, '') === b.replace(/\[.*$/, '')
/** one line of a message for a notification body */
const snippet = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, 140) : undefined

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
  /** custom (/rename) title, else the AI-generated one; absent until either exists */
  session_name?: string
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number }
    seven_day?: { used_percentage?: number; resets_at?: number }
  }
}

/** kinds of OS notification a session can request via the 'notify' event */
export type NotifyKind = 'attention' | 'done' | 'rate-limited' | 'fallback'
export interface NotifyEvent {
  id: string
  kind: NotifyKind
  /** extra line for the notification body (last message, prompt, model pair) */
  detail?: string
}

/** Emits 'notify' (NotifyEvent) so the main process can raise an OS notification. */
export class SessionManager extends EventEmitter {
  readonly hooks: HookServer
  /** sessions awaiting a "continue" once their (re)started claude is ready */
  private pendingContinue = new Set<string>()
  /** sessions to put back into ultracode once their (re)started claude is ready —
   *  the CLI flag is session-only and never survives a new process */
  private pendingUltracode = new Set<string>()
  /** sessions whose TUI has rendered its input box since the last spawn — the
   *  gate for delivering queued submissions (see send()) */
  private tuiReady = new Set<string>()
  /** sessions whose screen is currently a picker/panel/dialog (/model, /usage,
   *  a permission prompt…) — pasting there goes nowhere, and an Enter could
   *  pick something in a menu */
  private modal = new Set<string>()
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
  /** id → display name mirror of store.knownModels: the per-statusline check is
   *  a Map lookup, and the store is only written for a new or renamed model */
  private knownModels: Map<string, string> | null = null
  /** when the user last pressed Esc in a session's terminal — an interrupt
   *  notice right after it means the turn ended (no Stop hook fires for that) */
  private escAt = new Map<string, number>()
  /** statusline-vs-configured model mismatches waiting out FALLBACK_GRACE_MS */
  private fallbackTimers = new Map<string, NodeJS.Timeout>()
  /** the limit banner last acted on per session — the notice stays in the
   *  conversation and repaints on scroll, which must not park the account again */
  private lastBanner = new Map<string, string>()
  /** the model each live process is known to run: what it was launched with,
   *  the first statusline of a "default" launch, or a user /model — the
   *  yardstick for fallback detection (NOT the persisted modelId, which the
   *  settings form may change ahead of the next restart) */
  private launchedModel = new Map<string, string | null>()
  /** why a session is in needs-attention: a dialog awaiting a key, or paused
   *  by us (fallback stop / login prompt) with nothing waiting for input */
  private attentionKind = new Map<string, 'dialog' | 'paused'>()
  /** sessions whose last Stop was held back by background agents still running */
  private deferredStop = new Set<string>()

  constructor(
    private store: AppStore,
    private accounts: AccountManager,
    private onChange: () => void,
    readonly ptys: PtyManager
  ) {
    super()
    this.hooks = new HookServer((sessionId) => {
      const s = this.get(sessionId)
      const name = s ? (this.accounts.get(s.accountDir)?.name ?? '') : ''
      return `◉ agents · ${name}`
    })
    this.hooks.on('event', (ev: HookEvent) => this.onHookEvent(ev))
    this.ptys.on('data', ({ id, data }: { id: string; data: string }) => this.scanOutput(id, data))
    this.ptys.on('exit', ({ id, exitCode, tail }: { id: string; exitCode: number; tail: string }) => {
      // quitting: preserve state so restore knows what was active; login ptys aren't sessions
      if (this.shuttingDown || !this.get(id)) return
      console.warn(`[session] ${id} claude exited (code ${exitCode}): ${stripAnsi(tail).replace(/\s+/g, ' ').trim().slice(-200)}`)
      this.clearFallbackTimer(id) // a mismatch seen by a process that just died is moot
      this.launchedModel.delete(id)
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
        cliTitle: s.cliTitle ?? null,
        autoTitle: s.autoTitle ?? s.cliTitle ?? null,
        stopOnFallback: s.stopOnFallback ?? false,
        fallbackModel: null,
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
    // blank account → the one that should be spent next for this model
    const accountDir = input.accountDir || this.accounts.pickAccount({ model: input.modelId })?.configDir
    if (!accountDir) throw new Error('no logged-in account available')
    pushRecentLaunchArgs(this.store, input.launchArgs)
    const session: Session = {
      id: randomUUID(),
      title: input.title.trim() || null,
      cliTitle: null,
      autoTitle: null,
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
      draft: null,
      stopOnFallback: input.stopOnFallback,
      fallbackModel: null
    }
    this.store.set('sessions', [...this.list(), session])
    await this.spawn(session, { resume: false })
    this.onChange()
    return session.id
  }

  async restart(id: string): Promise<void> {
    const session = this.get(id)
    if (!session || this.ptys.isAlive(id)) return
    // a session stopped before its first exchange has an id but no transcript:
    // `--resume` would only die and respawn fresh (dropping anything queued
    // for it meanwhile) — start fresh directly, as switchAccount does
    const canResume = !!session.claudeSessionId && !!session.transcriptPath && existsSync(session.transcriptPath)
    if (!canResume && session.claudeSessionId) this.update(id, { claudeSessionId: null, transcriptPath: null })
    if (canResume) this.resuming.add(id) // watch for a failed resume
    await this.spawn(this.get(id)!, { resume: canResume })
    this.update(id, { state: 'idle' })
  }

  /**
   * Stop a running session without removing it — kill claude so the card becomes
   * "exited — click to resume", keeping its record + transcript for later resume.
   */
  stop(id: string): void {
    this.clearResetTimer(id)
    this.clearFallbackTimer(id)
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
    this.pendingContinue.delete(id) // a "continue" into a brand-new empty conversation is nonsense
    this.tail.delete(id)
    this.update(id, { claudeSessionId: null, transcriptPath: null })
    const session = this.get(id)
    if (!session) return
    const queued = this.sendQueue.get(id) ?? [] // a message sent to the exited card must ride into the fresh process
    await this.spawn(session, { resume: false })
    for (const text of queued) this.send(id, text)
  }

  remove(id: string): void {
    this.clearResetTimer(id)
    this.clearFallbackTimer(id)
    this.escAt.delete(id)
    this.lastBanner.delete(id)
    this.deferredStop.delete(id)
    this.tail.delete(id)
    this.trusted.delete(id)
    this.bypassAccepted.delete(id)
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
    if (patch.stopOnFallback !== undefined) p.stopOnFallback = patch.stopOnFallback
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
      this.resuming.delete(id) // our kill must not read as a failed --resume
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

    // a switch during a still-booting --resume: our kill is not a failed resume
    // (the exit handler would otherwise wipe the transcript info and respawn
    // fresh on the OLD account, racing this switch)
    this.resuming.delete(id)
    this.clearFallbackTimer(id)
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
    else this.pendingContinue.delete(id) // a stale one from an earlier switch must not fire here
    if (canResume) this.resuming.add(id) // fall back to fresh if the resume still fails
    await this.spawn(this.get(id)!, { resume: canResume })
  }

  write(id: string, data: string): void {
    // clicking/scrolling a mouse-tracking terminal (claude's pinned mode) writes
    // mouse/focus reports — those aren't the user re-engaging, so they must not
    // clear a done/needs-attention badge just because the user glanced at the card
    if (isKeyboardInput(data)) {
      const s = this.get(id)
      if (data === '\x1b') this.escAt.set(id, Date.now())
      // done → they're starting something new; needs-attention → an ANSWER
      // (Enter, or a single key like y/1/2) means claude carries on — arrow/tab
      // navigation inside the prompt doesn't, and Esc dismisses it (the
      // interrupt notice, not this, decides)
      if (s?.state === 'done') this.update(id, { state: 'idle' })
      else if (s?.state === 'needs-attention' && data !== '\x1b') {
        // paused by us (fallback stop / login prompt): nothing is waiting, they're
        // composing — idle until their submit; a dialog: an answer resumes the turn
        if (this.attentionKind.get(id) === 'paused') this.update(id, { state: 'idle' })
        else if (data.includes('\r') || /^[\x20-\x7e]$/.test(data)) this.update(id, { state: 'running' })
      }
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
    try {
      await this.maybeSwitchBeforeSubmit(id)
    } catch (e) {
      console.warn('[session] pre-submit account switch failed, sending anyway:', e) // the message must never be lost
    }
    // an exited card takes a message too: bring the session back (resume) and
    // let the queue deliver once its input box is up (spawn clears the queue,
    // so enqueue only after the restart is under way)
    if (!this.ptys.isAlive(id)) await this.restart(id)
    // a picker/panel in the way: Esc closes it (cancels /model without picking);
    // a dialog waiting on the user is theirs to answer — the text waits for the
    // input box to come back
    if (this.modal.has(id) && this.get(id)?.state !== 'needs-attention') this.ptys.write(id, '\x1b')
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
    this.bypassAccepted.delete(session.id) // the new process shows the disclaimer afresh
    this.trusted.delete(session.id) // …and may show a (new kind of) trust prompt afresh
    this.lastBanner.delete(session.id) // banners aren't replayed by --resume; a new process starts clean
    this.deferredStop.delete(session.id)
    this.attentionKind.delete(session.id)
    this.clearFallbackTimer(session.id)
    this.launchedModel.set(session.id, session.modelId) // what --model asks for (null = the CLI's default)
    this.clearSends(session.id) // queued submits from a prior incarnation must not fire into this one
    if (session.effort === 'ultracode') {
      this.pendingUltracode.add(session.id)
      this.update(session.id, { effort: null })
    }
    if (session.fallbackModel) this.update(session.id, { fallbackModel: null }) // --model puts the configured one back
    const settingsDir = join(app.getPath('userData'), 'session-settings')
    const settingsFile = writeSessionSettings(
      settingsDir,
      session.id,
      this.hooks.port,
      parseSettingsOverrides(session.settingsJson ?? '')
    )
    // a resumed transcript remembers its cloud bridge and the CLI reconnects it
    // regardless of remoteControlAtStartup — append the "disconnected" record
    // /rc writes, so the session comes back local like a fresh one
    if (opts.resume && session.claudeSessionId && session.transcriptPath) {
      unbridgeTranscript(session.transcriptPath, session.claudeSessionId)
    }
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
    // peer discovery is scoped to CLAUDE_CONFIG_DIR — share one registry so
    // sessions can message each other across accounts, not just within one
    linkSessionRegistry(session.accountDir)
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
    if (!session || session.limitRule !== 'auto-switch' || session.state === 'running') return
    const account = this.accounts.get(session.accountDir)
    const model = session.modelId ?? session.model
    if (!account || this.accounts.usedPct(account, modelFamily(model)) < HEADROOM_PCT) return
    const target = this.accounts.pickAccount({ exclude: session.accountDir, model })
    // no ping-pong between two nearly-spent accounts on every message
    if (target && this.accounts.usedPct(target, modelFamily(model)) < HEADROOM_PCT) {
      await this.switchAccount(id, target.configDir, { continueAfter: false })
    }
  }

  /** sessions whose trust prompt we've already auto-confirmed */
  private trusted = new Set<string>()
  /** sessions whose bypass-permissions disclaimer we've auto-accepted this
   *  process (re-armed on every spawn — claude re-shows it each launch) */
  private bypassAccepted = new Set<string>()
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
    // auto-confirm claude's first-run "trust this folder" prompt. Its default is
    // now "❯ No, exit" (a bare Enter QUITS claude — the account-switch resume then
    // dies on the new account), so move DOWN to "Yes, I trust this folder" first,
    // like the bypass disclaimer below. Decide at send time: the options paint a
    // beat after the heading, so re-read the tail then rather than trust `buf`.
    if (!this.trusted.has(id) && isTrustPrompt(buf)) {
      this.trusted.add(id)
      setTimeout(() => {
        if (preselectsExit(this.tail.get(id) ?? '')) this.ptys.write(id, '\x1b[B') // ↓ → Yes
        setTimeout(() => this.ptys.write(id, '\r'), 150)
      }, 500)
    }
    // auto-accept the bypass-permissions disclaimer when restoring that mode.
    // Its default is "No, exit", so move DOWN to "Yes, I accept" then confirm —
    // and do it fast: a bare Enter from anywhere else would select "No, exit"
    // and drop the session into an exit→respawn→disclaimer loop.
    if (!this.bypassAccepted.has(id) && isBypassWarning(buf)) {
      this.bypassAccepted.add(id)
      setTimeout(() => {
        this.ptys.write(id, '\x1b[B') // ↓ : No, exit → Yes, I accept
        setTimeout(() => this.ptys.write(id, '\r'), 150)
      }, 400)
    }
    // input box up (queued submissions may now actually land) vs a panel that
    // took the screen — tracked per chunk: panels repaint nothing while open
    const input = tuiInputState(data)
    if (input === 'modal') this.modal.add(id)
    else if (input === 'ready') {
      this.modal.delete(id)
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
    // Esc just pressed + the interrupt notice painted = the turn is over (no
    // Stop hook for interrupts). Checked on the new chunk only: the notice
    // lives on in the conversation and repaints on scroll.
    const esc = this.escAt.get(id)
    if (esc && Date.now() - esc < 3000 && isInterruptNotice(data)) {
      this.escAt.delete(id)
      if (session.state === 'running' || session.state === 'needs-attention') this.update(id, { state: 'idle' })
    }
    // the CLI wants this session to sign in: credentials died under a
    // "logged in" account — flag the account and hand the session to the user
    if (isLoginPrompt(data) && this.accounts.get(session.accountDir)?.loginStatus === 'logged_in') {
      this.accounts.markExpired(session.accountDir)
      this.attention(id, 'login', 'paused')
    }
    const limit = detectRateLimit(buf)
    if (limit && session.state !== 'rate-limited') {
      if (this.lastBanner.get(id) !== limit.banner) {
        this.lastBanner.set(id, limit.banner)
        void this.handleRateLimit(id, limit.window)
      } else if (session.state === 'running' && detectRateLimit(data)) {
        // the same notice again, freshly painted, in a new turn: a second hit of
        // the still-parked window (the CLI refused the turn) — not a scroll
        // repaint, which never coincides with a running turn on a live park
        const until = this.accounts.get(session.accountDir)?.usage.limitedUntil
        if (until != null && until > Date.now()) this.setState(id, 'rate-limited')
      }
    }
  }

  /** React to a session hitting its usage limit per its configured rule. */
  private async handleRateLimit(id: string, window: string): Promise<void> {
    const session = this.get(id)
    if (!session) return
    this.setState(id, 'rate-limited')
    // the banner is ground truth — keep this account out of the rotation until
    // that window resets (and probe its real numbers in the background)
    this.accounts.markRateLimited(session.accountDir, window)

    switch (session.limitRule) {
      case 'manual':
        this.emit('notify', { id, kind: 'rate-limited' })
        break
      case 'auto-switch': {
        const target = this.accounts.pickAccount({ exclude: session.accountDir, model: session.modelId ?? session.model })
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
        // a banner doesn't end the process — claude sits at its prompt, so a
        // restart() would no-op (live-hit: wait-and-continue never continued)
        if (this.ptys.isAlive(id)) this.send(id, 'continue')
        else {
          this.pendingContinue.add(id)
          void this.restart(id)
        }
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
      case 'UserPromptSubmit': {
        this.deferredStop.delete(sessionId)
        // a new request retitles an untitled card right away (claude's own
        // summary only ever describes a conversation's FIRST prompt); wake-ups
        // (task notifications, loops), slash commands and our own "continue" don't
        const source = payload['source']
        const prompt = typeof payload['prompt'] === 'string' ? payload['prompt'].trim() : ''
        if ((source === undefined || source === 'user' || source === 'sdk') && prompt && !prompt.startsWith('/') && prompt !== 'continue') {
          const line = prompt.split('\n')[0].replace(/\s+/g, ' ').trim()
          this.update(sessionId, { autoTitle: line.length > 40 ? `${line.slice(0, 40)}…` : line })
        }
        this.setState(sessionId, 'running')
        break
      }
      case 'Stop': {
        // Stop fires at every turn boundary, including the wake-ups background
        // agents trigger when they finish. The payload lists in-flight background
        // work — the SESSION is only done once nothing that will wake it remains.
        const tasks = (payload['background_tasks'] as { type?: string; task_type?: string }[] | undefined) ?? []
        if (tasks.some((t) => WAKING_TASK_TYPES.has(t.type ?? t.task_type ?? ''))) {
          this.deferredStop.add(sessionId)
          break
        }
        this.deferredStop.delete(sessionId)
        // a limit banner also ends the turn — don't repaint rate-limited as done
        if (session.state === 'rate-limited') break
        if (session.state !== 'done') {
          this.update(sessionId, { state: 'done' })
          this.emit('notify', { id: sessionId, kind: 'done', detail: snippet(payload['last_assistant_message']) })
        }
        // per-model (Fable) numbers only come from the panel probe — keep them
        // fresh for the accounts actually being spent
        this.accounts.refreshUsageIfStale(session.accountDir, 5 * 60_000)
        break
      }
      case 'Notification': {
        const type = String(payload['notification_type'] ?? '')
        if (!type || ATTENTION_NOTIFICATIONS.has(type)) this.attention(sessionId, snippet(payload['message']))
        else if (type === 'push_notification') this.emit('notify', { id: sessionId, kind: 'attention', detail: snippet(payload['message']) })
        // "Claude is waiting for your input" while we still think it's working
        // and no background agent is pending: the turn ended without a Stop (an
        // interrupt) — it's idle. With agents pending, running is the truth.
        else if (type === 'idle_prompt' && session.state === 'running' && !this.deferredStop.has(sessionId)) {
          this.setState(sessionId, 'idle')
        }
        break
      }
      case 'PreToolUse': // AskUserQuestion / ExitPlanMode: a dialog is up, waiting
        this.attention(sessionId, String(payload['tool_name'] ?? ''))
        break
      case 'PostToolUse': // …and answered
        if (session.state === 'needs-attention') this.setState(sessionId, 'running')
        break
      case 'PostModelSwitch': {
        const to = String(payload['to_model'] ?? '')
        if (!to) break
        this.clearFallbackTimer(sessionId)
        const launched = this.launchedModel.get(sessionId) ?? session.modelId
        // automatic: a fallback — or the CLI putting the requested model back
        // (retry/revert), which is the fallback ending, not a new one
        if (payload['source'] === 'auto') {
          if (launched && sameModel(to, launched)) this.update(sessionId, { fallbackModel: null })
          else this.onFallback(sessionId, to)
        }
        // a resume restores whatever the transcript last ran on — possibly a
        // sticky fallback; the flag we passed is still the configured model
        else if (payload['source'] === 'resume') {
          this.launchedModel.set(sessionId, to)
          if (session.modelId && !sameModel(to, session.modelId)) this.update(sessionId, { fallbackModel: to })
        }
        // a deliberate /model (or picker): that IS the session's model now
        else {
          this.launchedModel.set(sessionId, to)
          this.update(sessionId, { modelId: to, fallbackModel: null })
        }
        break
      }
      case 'statusline':
        this.onStatusline(session, payload as StatuslinePayload)
        break
    }
  }

  private onStatusline(session: Session, p: StatuslinePayload): void {
    // a killed process's in-flight statusline POST can land after a respawn
    // began — it must not overwrite freshly-configured model/effort values
    if (!this.ptys.isAlive(session.id)) return
    const liveId = p.model?.id
    if (liveId) this.recordModel(liveId, p.model?.display_name ?? liveId)
    const model = p.model?.display_name ?? session.model
    // the configured model is adopted from the first statusline only ("default"
    // becomes concrete so respawns pin it); after that a different live model
    // is either a user /model (PostModelSwitch says so) or a fallback (below)
    const modelId = session.modelId ?? liveId ?? null
    // ultracode reports as plain xhigh here (scanOutput sets/clears the label)
    const level = p.effort?.level ?? session.effort
    const effort = session.effort === 'ultracode' && level === 'xhigh' ? 'ultracode' : level
    // claude's own title: absent until its AI summary lands (a few seconds
    // after the first prompt) and absent again once /clear starts a new
    // conversation — mirror it as-is rather than keeping a stale one
    const cliTitle = p.session_name ?? null
    if (
      model !== session.model ||
      effort !== session.effort ||
      modelId !== session.modelId ||
      cliTitle !== session.cliTitle
    ) {
      // a (re)generated CLI title beats the request line; /clear (title gone) blanks it
      this.update(session.id, { model, effort, modelId, cliTitle, ...(cliTitle !== session.cliTitle && { autoTitle: cliTitle }) })
    }
    // a "default" launch runs whatever the first statusline says it runs
    if (liveId && !this.launchedModel.get(session.id)) this.launchedModel.set(session.id, liveId)
    const expected = this.launchedModel.get(session.id)
    // live model ≠ what this process was launched with: give a user-initiated
    // PostModelSwitch a moment to claim it, else it's the CLI falling back on
    // its own. (A modelId edited in the settings while the session runs waits
    // for the next restart — it is not this process's model, so not a mismatch.)
    if (liveId && expected && !sameModel(liveId, expected)) {
      if (!session.fallbackModel && !this.fallbackTimers.has(session.id)) {
        this.fallbackTimers.set(
          session.id,
          setTimeout(() => {
            this.fallbackTimers.delete(session.id)
            const still = this.launchedModel.get(session.id)
            if (still && !sameModel(liveId, still) && this.ptys.isAlive(session.id)) this.onFallback(session.id, liveId)
          }, FALLBACK_GRACE_MS)
        )
      }
    } else if (session.fallbackModel && liveId) {
      this.clearFallbackTimer(session.id)
      this.update(session.id, { fallbackModel: null }) // back on the launched model
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
    if (this.modal.has(id)) return // a panel is up; its closing repaint re-drains
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
      if (!this.modal.has(id)) this.ptys.write(id, '\r') // the text already sits in the input box (never into a menu)
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
    this.modal.delete(id)
  }

  /** submitting into a finished session brings it back to plain idle — unless
   *  a dialog is still waiting on the user (the text queues behind it) */
  private clearFinished(id: string): void {
    const s = this.get(id)
    if (!s) return
    if (s.state === 'done' || (s.state === 'needs-attention' && this.attentionKind.get(id) !== 'dialog')) {
      this.update(id, { state: 'idle' })
    }
  }

  private setState(id: string, state: SessionState): void {
    if (this.get(id)?.state !== state) this.update(id, { state })
  }

  /** The TUI is waiting on the user. One notification per wait: a PreToolUse
   *  dialog and its permission_prompt Notification would otherwise both fire. */
  private attention(id: string, detail?: string, kind: 'dialog' | 'paused' = 'dialog'): void {
    this.attentionKind.set(id, kind) // a dialog opening on a paused session makes it a dialog wait
    if (this.get(id)?.state === 'needs-attention') return
    this.update(id, { state: 'needs-attention' })
    this.emit('notify', { id, kind: 'attention', detail })
  }

  /** The CLI swapped the session onto another model by itself (safeguards
   *  refusal, overload…). Remember it for the card; when the session opted in,
   *  interrupt the turn now running on the stand-in and hand it to the user. */
  private onFallback(id: string, toModel: string): void {
    const session = this.get(id)
    if (!session || session.fallbackModel === toModel) return
    this.update(id, { fallbackModel: toModel })
    if (!session.stopOnFallback) return
    this.abandonSends(id)
    if (session.state === 'running') this.ptys.write(id, '\x1b') // Esc: stop the fallback model mid-turn
    this.attentionKind.set(id, 'paused')
    this.update(id, { state: 'needs-attention' })
    this.emit('notify', { id, kind: 'fallback', detail: `${session.modelId ?? session.model ?? '?'} → ${toModel}` })
  }

  private clearFallbackTimer(id: string): void {
    const t = this.fallbackTimers.get(id)
    if (t) clearTimeout(t)
    this.fallbackTimers.delete(id)
  }

  /** Remember a model the CLI reported — the picker lists these after its
   *  presets, so a new release is selectable without an app update. */
  private recordModel(id: string, name: string): void {
    this.knownModels ??= new Map((this.store.get('knownModels') ?? []).map((m) => [m.id, m.name]))
    if (this.knownModels.get(id) === name) return
    this.knownModels.set(id, name)
    this.store.set(
      'knownModels',
      [...this.knownModels].map(([id, name]) => ({ id, name }))
    )
    this.onChange()
  }

  private update(id: string, patch: Partial<Session>): void {
    this.store.set(
      'sessions',
      this.list().map((s) => (s.id === id ? { ...s, ...patch } : s))
    )
    this.onChange()
  }
}
