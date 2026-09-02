import { readdirSync, readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { Account, AccountUsage } from '../shared/types'
import type { LoginLinks, LoginResult, NewAccountInput } from '../shared/ipc'
import type { AppStore } from './store'
import type { PtyManager } from './pty-manager'
import { authStatus, claudeLogout, claudePath, envFor, extractLoginUrl, fetchUsage, scratchCwd, stripAnsi } from './claude-cli'

/** utilization at/above which an account is treated as (nearly) spent:
 *  sessions switch away before submitting, and pickAccount prefers others */
export const HEADROOM_PCT = 95

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function normalize(path: string): string {
  const p = path.trim().replace(/^~(?=$|\/)/, homedir())
  return resolve(p)
}

function displayName(configDir: string): string {
  const marker = join(configDir, '.profile-name') // claude-switch convention
  try {
    return readFileSync(marker, 'utf8').trim() || basename(configDir)
  } catch {
    const base = basename(configDir)
    return base === '.claude' ? 'default' : base.replace(/^\.claude-/, '')
  }
}

function emptyUsage(): AccountUsage {
  return { fiveHour: null, weekly: null, resetsAt: null, weeklyResetsAt: null, weeklyModels: [], limitedUntil: null, updatedAt: null }
}

/** "fable" | "opus" | "sonnet" | … from a model id or display name — the key
 *  the /usage panel's per-model windows are matched on ("claude-fable-5-1[1m]"
 *  → fable, "Opus 5 (1M context)" → opus, "Current week (Fable)" → fable). */
export function modelFamily(model: string | null | undefined): string | null {
  const m = /^(?:claude-)?([a-z]+)/i.exec((model ?? '').trim())
  return m ? m[1].toLowerCase() : null
}

export class AccountManager {
  /** in-progress `claude auth login` processes, by config dir (ptys hold the process) */
  private logins = new Set<string>()
  /** config dirs with a /usage probe already in flight — panel-open, the
   *  periodic refresh and limit detection can overlap; one probe is enough */
  private probing = new Set<string>()
  /** epoch ms of the last completed panel probe per account (statusline
   *  patches keep usage.updatedAt moving, so freshness of the per-model numbers
   *  needs its own clock) */
  private probedAt = new Map<string, number>()
  /** last line each account's login process printed before it ended */
  private loginVerdicts = new Map<string, string>()

  constructor(
    private store: AppStore,
    private onChange: () => void,
    private ptys: PtyManager
  ) {
    // a login process ended (pasted code, browser callback, typed in the
    // terminal, or aborted) — whatever happened, the auth state is the truth
    this.ptys.on('exit', ({ id, tail }: { id: string; tail: string }) => {
      const dir = loginDirOf(id)
      if (dir === null || !this.logins.delete(dir)) return
      // keep the CLI's last word ("Login successful." / "Login failed: …") for
      // the dialog — its links died with the process
      const last = stripAnsi(tail).split('\n').map((l) => l.trim()).filter(Boolean).at(-1)
      this.loginVerdicts.set(dir, last ?? '')
      this.ptys.forget(id)
      void this.refreshAuth(dir)
    })
  }

  list(): Account[] {
    // tolerate accounts persisted before newer fields existed
    return (this.store.get('accounts') ?? []).map((a) => ({
      ...a,
      note: a.note ?? '',
      usage: {
        ...a.usage,
        weeklyModels: (a.usage?.weeklyModels ?? []).map((m) => ({ ...m, resetsAt: m.resetsAt ?? null })),
        limitedUntil: a.usage?.limitedUntil ?? null
      },
      usageRefreshing: this.probing.has(a.configDir),
      loginActive: this.logins.has(a.configDir),
      loginVerdict: this.loginVerdicts.get(a.configDir) ?? null
    }))
  }

  get(configDir: string): Account | undefined {
    return this.list().find((a) => a.configDir === configDir)
  }

  /**
   * Register an account. Name comes first; an empty path defaults to
   * ~/.claude-<name>. Creates the dir if missing.
   */
  async register(input: NewAccountInput): Promise<void> {
    const name = input.name.trim()
    if (!name) throw new Error('name required')
    const rawPath = input.path.trim() || join(homedir(), `.claude-${name}`)
    const configDir = normalize(rawPath)
    if (!isAbsolute(configDir)) throw new Error(`invalid path: ${rawPath}`)
    if (this.get(configDir)) throw new Error(`already registered: ${configDir}`)
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
    else if (!statSync(configDir).isDirectory()) throw new Error(`not a directory: ${configDir}`)

    const account: Account = {
      configDir,
      name,
      note: input.note.trim(),
      email: null,
      subscriptionType: null,
      loginStatus: 'unknown',
      authCheckedAt: null,
      usage: emptyUsage()
    }
    this.store.set('accounts', [...this.persisted(), account])
    this.onChange()
    await this.refreshAuth(configDir)
  }

  updateNote(configDir: string, note: string): void {
    this.update(configDir, { note })
  }

  /** Scan ~/.claude and ~/.claude-* (claude-switch convention), register new
   *  ones, then re-check auth for everyone. */
  async discover(): Promise<void> {
    const home = homedir()
    const candidates: string[] = []
    // the default profile keeps its .claude.json at ~/.claude.json, not inside
    if (existsSync(join(home, '.claude')) && existsSync(join(home, '.claude.json'))) {
      candidates.push(join(home, '.claude'))
    }
    for (const entry of readdirSync(home)) {
      const dir = join(home, entry)
      if (entry.startsWith('.claude-') && statSync(dir).isDirectory() && existsSync(join(dir, '.claude.json'))) {
        candidates.push(dir)
      }
    }
    // register newly-found dirs directly (register() expects user input)
    for (const dir of candidates.filter((d) => !this.get(d))) {
      const account: Account = {
        configDir: dir,
        name: displayName(dir),
        note: '',
        email: null,
        subscriptionType: null,
        loginStatus: 'unknown',
        authCheckedAt: null,
        usage: emptyUsage()
      }
      this.store.set('accounts', [...this.persisted(), account])
    }
    this.onChange()
    await this.refreshAllAuth()
  }

  /** Re-check login status, then (best-effort) usage. `withUsage=false` skips
   *  the slow /usage probe (used for the fast concurrent startup pass). */
  async refreshAuth(configDir: string, withUsage = true): Promise<void> {
    const account = this.get(configDir)
    if (!account) return
    try {
      const st = await authStatus(configDir)
      this.update(configDir, {
        email: st.email ?? account.email,
        subscriptionType: st.subscriptionType ?? account.subscriptionType,
        // previously-known email + no longer logged in = expired, needs re-login
        loginStatus: st.loggedIn ? 'logged_in' : account.email ? 'expired' : 'logged_out',
        authCheckedAt: Date.now()
      })
      if (st.loggedIn && withUsage) await this.refreshUsage(configDir)
    } catch {
      this.update(configDir, { loginStatus: 'unknown', authCheckedAt: Date.now() })
    }
  }

  async refreshUsage(configDir: string): Promise<void> {
    if (process.env['AGENTS_NO_USAGE_FETCH'] || this.probing.has(configDir)) return
    this.probing.add(configDir)
    this.onChange() // usageRefreshing → the panel shows a spinner instead of stale-looking numbers
    try {
      const usage = await fetchUsage(configDir) // best-effort (scrapes claude /usage)
      // Full replace, but NEVER let a routine scrape lift a live banner-set park:
      // markRateLimited() itself kicks a probe, and a per-model/Opus limit fires a
      // banner while the panel still reads < 100%. Clearing the park here bounced
      // the session straight back onto the limited account — an endless switch
      // loop. The park expires on its own at limitedUntil (the window reset).
      if (usage) this.update(configDir, { usage: { ...usage, limitedUntil: this.livePark(configDir) ?? usage.limitedUntil } })
      else console.warn(`[usage] probe returned nothing for ${configDir} — keeping the previous numbers`)
    } finally {
      this.probedAt.set(configDir, Date.now()) // the attempt counts: a failing account is retried per maxAgeMs, not per turn
      this.probing.delete(configDir)
      this.onChange()
    }
  }

  /** Probe unless a probe landed within maxAgeMs — the per-model (Fable)
   *  windows only ever come from the panel, so accounts in active use are
   *  re-read at turn boundaries rather than waiting for the periodic sweep. */
  refreshUsageIfStale(configDir: string, maxAgeMs: number): void {
    const a = this.get(configDir)
    if (!a || a.loginStatus !== 'logged_in') return
    if (Date.now() - (this.probedAt.get(configDir) ?? 0) < maxAgeMs) return
    void this.refreshUsage(configDir)
  }

  /** A still-future banner-set exhaustion park for this account, else null.
   *  Usage writes carry it forward so only elapsed time clears it. */
  private livePark(configDir: string): number | null {
    const until = this.get(configDir)?.usage.limitedUntil
    return until != null && until > Date.now() ? until : null
  }

  /** Startup: auth for everyone concurrently (fast, no usage probes). */
  async refreshAllAuth(): Promise<void> {
    await Promise.all(this.list().map((a) => this.refreshAuth(a.configDir, false)))
  }

  /** Usage for every logged-in account, concurrently (each probe is its own
   *  claude process). Runs after startup, periodically, and when the
   *  Settings/accounts view opens. */
  async refreshAllUsage(): Promise<void> {
    await Promise.all(
      this.list()
        .filter((a) => a.loginStatus === 'logged_in')
        .map((a) => this.refreshUsage(a.configDir))
    )
  }

  /** Called by SessionManager when a statusline event carries rate_limits.
   *  A statusline round-trip does NOT prove recovery — one posts on the same
   *  turn a limit banner ends — so it must not lift a live park either; only the
   *  park's own expiry (the window reset) clears it. */
  updateUsage(configDir: string, usage: Partial<AccountUsage>): void {
    const account = this.get(configDir)
    if (!account) return
    const u = account.usage
    const park = this.livePark(configDir)
    // statusline events arrive on every repaint — unchanged numbers don't earn
    // a config write + broadcast (the freshness stamp still moves once a minute)
    const same =
      (Object.keys(usage) as (keyof AccountUsage)[]).every((k) => usage[k] === u[k]) && u.limitedUntil === park
    if (same && Date.now() - (u.updatedAt ?? 0) < 60_000) return
    this.update(configDir, { usage: { ...u, ...usage, limitedUntil: park, updatedAt: Date.now() } })
  }

  /** A session on this account just saw claude's "limit hit" banner for
   *  `window` ("session" | "weekly" | "fable 5" | "opus" | "usage credit"…).
   *  Park the account until THAT window resets (a weekly/per-model banner
   *  parked only until the 5h reset bounced auto-switch back every 5h), or
   *  briefly when the reset is unknown, so pickAccount can't return to it on
   *  stale numbers; then probe the real state in the background. */
  markRateLimited(configDir: string, window: string): void {
    const account = this.get(configDir)
    if (!account) return
    const u = account.usage
    const now = Date.now()
    const future = (t: number | null | undefined): number | null => (t != null && t > now ? t : null)
    const family = modelFamily(window)
    const limitedUntil =
      (/^week/.test(window) ? future(u.weeklyResetsAt) : null) ??
      (family && !/^(session|usage|monthly)/.test(window)
        ? future(u.weeklyModels.find((m) => modelFamily(m.name) === family)?.resetsAt ?? u.weeklyResetsAt)
        : null) ??
      (/^session/.test(window) ? future(u.resetsAt) : null) ??
      now + 30 * 60_000
    this.update(configDir, { usage: { ...u, limitedUntil } })
    void this.refreshUsage(configDir)
  }

  /** A session on this account was asked by the CLI to sign in again — the
   *  stored credentials are dead even though `auth status` still reads them. */
  markExpired(configDir: string): void {
    if (this.get(configDir)?.loginStatus === 'logged_in') this.update(configDir, { loginStatus: 'expired' })
  }

  /**
   * Utilization (0-100) of the tightest window that binds a session on this
   * model family: the banner park, the 5-hour and weekly windows, and the
   * family's own weekly window when the panel lists one. Other families'
   * windows don't count — a spent Opus window is no reason to keep a Fable
   * session off the account (family=null: every per-model window counts). A
   * window whose reset time has passed reads as free again (stale data).
   */
  usedPct(a: Account, family: string | null): number {
    const now = Date.now()
    const eff = (pct: number | null, resetsAt: number | null): number =>
      pct == null || (resetsAt != null && resetsAt <= now) ? 0 : pct
    const u = a.usage
    return Math.max(
      u.limitedUntil != null && u.limitedUntil > now ? 100 : 0,
      eff(u.fiveHour, u.resetsAt),
      eff(u.weekly, u.weeklyResetsAt),
      ...u.weeklyModels
        .filter((m) => !family || modelFamily(m.name) === family)
        // a per-model window without its own reset time follows the weekly one
        .map((m) => eff(m.percent, m.resetsAt ?? u.weeklyResetsAt))
    )
  }

  /**
   * The account a session should run on. Logged-in accounts with headroom on
   * every window that binds the session's model qualify; among them the one
   * whose weekly window resets SOONEST wins — spend what is about to be handed
   * back first — with lower utilization as the tie-break. Accounts already
   * past HEADROOM_PCT only get picked when nothing better is left. Unknown
   * usage counts as free; an unknown weekly reset sorts last. Used for
   * auto-switch and for a new session left on "auto".
   */
  pickAccount(opts: { exclude?: string; model?: string | null } = {}): Account | null {
    const family = modelFamily(opts.model)
    const used = (a: Account): number => this.usedPct(a, family)
    const resetAt = (a: Account): number => a.usage.weeklyResetsAt ?? Number.POSITIVE_INFINITY
    const candidates = this.list()
      .filter((a) => a.configDir !== opts.exclude && a.loginStatus === 'logged_in' && used(a) < 100)
      .sort((a, b) => resetAt(a) - resetAt(b) || used(a) - used(b))
    return candidates.find((a) => used(a) < HEADROOM_PCT) ?? candidates[0] ?? null
  }

  /** Remove the account record AND its config directory (never the default ~/.claude). */
  remove(configDir: string): void {
    this.cancelLogin(configDir)
    this.store.set(
      'accounts',
      this.persisted().filter((a) => a.configDir !== configDir)
    )
    this.onChange()
    if (resolve(configDir) !== join(homedir(), '.claude')) {
      rmSync(configDir, { recursive: true, force: true })
    }
  }

  // ── login (OAuth, via `claude auth login` in a pty) ─────────────────────────
  private shimDir: string | null = null

  /**
   * A PATH dir whose `open`/`xdg-open` records the URL claude wants the browser
   * to load (into $AGENTS_LOGIN_URL_FILE) and exits 0. Claude then believes a
   * browser is up: its localhost callback keeps listening (that recorded URL
   * completes the login by itself when opened here) AND it still prints the
   * copy-anywhere link + "Paste code here" fallback — so one process serves
   * every way in, and no browser pops up on its own. One-time, cached.
   */
  private browserShim(): string {
    if (!this.shimDir) {
      const dir = mkdtempSync(join(tmpdir(), 'agents-login-'))
      for (const cmd of ['open', 'xdg-open']) {
        const p = join(dir, cmd)
        writeFileSync(p, '#!/bin/sh\n[ -n "$AGENTS_LOGIN_URL_FILE" ] && printf %s "$1" > "$AGENTS_LOGIN_URL_FILE"\nexit 0\n')
        chmodSync(p, 0o755)
      }
      this.shimDir = dir
    }
    return this.shimDir
  }

  /**
   * Start `claude auth login` for an account and resolve with its links. The
   * pty stays alive — waiting for the pasted code, the browser callback, or
   * the user typing into the dialog's terminal (it IS the CLI's own prompt).
   */
  async startLogin(configDir: string): Promise<LoginLinks> {
    const id = loginPtyId(configDir)
    this.cancelLogin(configDir)
    const [env, bin] = await Promise.all([envFor(configDir), claudePath()])
    // Re-cancel right before spawning: React StrictMode (dev) mounts the dialog
    // twice, so two startLogin calls race. Kill + spawn + register with no await
    // in between guarantees exactly one live login pty — otherwise the links
    // shown and the pty that receives the code have DIFFERENT OAuth states.
    this.cancelLogin(configDir)
    const urlFile = join(this.browserShim(), `url-${createHash('sha1').update(configDir).digest('hex').slice(0, 8)}`)
    rmSync(urlFile, { force: true })
    env['PATH'] = `${this.browserShim()}:${env['PATH'] ?? ''}`
    env['AGENTS_LOGIN_URL_FILE'] = urlFile
    this.loginVerdicts.delete(configDir)
    this.ptys.spawn(id, bin, ['auth', 'login'], { cwd: scratchCwd(), env })
    this.logins.add(configDir)
    this.onChange() // loginActive
    const manualUrl = await this.awaitOutput(id, 20_000, (out) => extractLoginUrl(out))
    if (!manualUrl) {
      this.cancelLogin(configDir)
      throw new Error(this.ptys.isAlive(id) ? 'login URL not found' : 'login process exited before printing a sign-in link')
    }
    // the shim runs the instant claude "opens the browser", just before it
    // prints the link — give the file a beat in case that order ever flips
    let browserUrl: string | null = null
    for (let i = 0; i < 20 && !browserUrl; i++) {
      try {
        browserUrl = readFileSync(urlFile, 'utf8').trim() || null
      } catch {
        await sleep(100)
      }
    }
    return { manualUrl, browserUrl, ptyId: id }
  }

  /** Write the pasted code (if the login is still waiting), then report the
   *  CLI's verdict: its own error line when it printed one (an "Invalid code"
   *  leaves the prompt up for another try), else the auth state after exit. */
  async submitLoginCode(configDir: string, code: string): Promise<LoginResult> {
    const id = loginPtyId(configDir)
    let message: string | null = null
    if (this.ptys.isAlive(id)) {
      // send the (long) code, then Enter after a beat so the whole line is buffered
      // before submit — an immediate CR can cut a long paste short → "invalid code"
      this.ptys.write(id, code.trim())
      setTimeout(() => this.ptys.write(id, '\r'), 80)
      message = await this.awaitOutput(id, 25_000, (out) => /Invalid code[^\n\r]*|Login failed[^\n\r]*/i.exec(stripAnsi(out))?.[0].trim() ?? null)
      if (message && /Invalid code/i.test(message) && this.ptys.isAlive(id)) return { ok: false, message } // still waiting — retry
    }
    // the pty may already be gone (it exited on success/failure, or a browser
    // callback finished the login) — the outcome is whatever auth says now
    if (message) this.loginVerdicts.set(configDir, message) // we saw its last word before the exit event could
    this.cancelLogin(configDir)
    await this.refreshAuth(configDir)
    return { ok: this.get(configDir)?.loginStatus === 'logged_in', message }
  }

  /** Resolve with the first non-null `pick(outputSoFar)` from the login pty,
   *  or null once it exits / after timeoutMs. */
  private awaitOutput<T>(id: string, timeoutMs: number, pick: (out: string) => T | null): Promise<T | null> {
    return new Promise((resolve) => {
      let out = ''
      const finish = (v: T | null): void => {
        clearTimeout(timer)
        this.ptys.off('data', onData)
        this.ptys.off('exit', onExit)
        resolve(v)
      }
      const onData = ({ id: pid, data }: { id: string; data: string }): void => {
        if (pid !== id) return
        out += data
        const v = pick(out)
        if (v !== null) finish(v)
      }
      const onExit = ({ id: pid }: { id: string }): void => {
        if (pid === id) finish(pick(out)) // the verdict may sit in the final output
      }
      const timer = setTimeout(() => finish(null), timeoutMs)
      this.ptys.on('data', onData)
      this.ptys.on('exit', onExit)
    })
  }

  /** Log the account out, then refresh its status. */
  async logout(configDir: string): Promise<void> {
    this.cancelLogin(configDir)
    try {
      await claudeLogout(configDir)
    } catch {
      /* best-effort — refreshAuth reflects the real state */
    }
    await this.refreshAuth(configDir)
  }

  /** Abort an in-progress login (dialog closed / account removed). */
  cancelLogin(configDir: string): void {
    if (!this.logins.delete(configDir)) return
    const id = loginPtyId(configDir)
    this.ptys.kill(id, 'SIGKILL') // nothing to flush — and a restart may reuse the id right away
    this.ptys.forget(id)
    this.onChange()
  }

  shutdown(): void {
    for (const dir of [...this.logins]) this.cancelLogin(dir)
  }

  /** the stored records — list() adds runtime-only fields that must not be written back */
  private persisted(): Account[] {
    return this.list().map(({ usageRefreshing: _u, loginActive: _l, loginVerdict: _v, ...a }) => a)
  }

  private update(configDir: string, patch: Partial<Account>): void {
    this.store.set(
      'accounts',
      this.persisted().map((a) => (a.configDir === configDir ? { ...a, ...patch } : a))
    )
    this.onChange()
  }
}

/** pty id of an account's login process — the dialog mounts a terminal on it */
const loginPtyId = (configDir: string): string => `login:${configDir}`
const loginDirOf = (ptyId: string): string | null => (ptyId.startsWith('login:') ? ptyId.slice(6) : null)
