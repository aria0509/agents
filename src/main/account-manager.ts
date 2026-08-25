import pty from 'node-pty'
import { readdirSync, readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { Account, AccountUsage } from '../shared/types'
import type { NewAccountInput } from '../shared/ipc'
import type { AppStore } from './store'
import { authStatus, claudeLogout, claudePath, envFor, extractLoginUrl, fetchUsage, scratchCwd } from './claude-cli'

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

export class AccountManager {
  constructor(
    private store: AppStore,
    private onChange: () => void
  ) {}

  list(): Account[] {
    // tolerate accounts persisted before newer fields existed
    return (this.store.get('accounts') ?? []).map((a) => ({
      ...a,
      note: a.note ?? '',
      usage: {
        ...a.usage,
        weeklyModels: (a.usage?.weeklyModels ?? []).map((m) => ({ ...m, resetsAt: m.resetsAt ?? null })),
        limitedUntil: a.usage?.limitedUntil ?? null
      }
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
    this.store.set('accounts', [...this.list(), account])
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
      this.store.set('accounts', [...this.list(), account])
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

  /** config dirs with a /usage probe already in flight — panel-open, the
   *  periodic refresh and limit detection can overlap; one probe is enough */
  private probing = new Set<string>()

  async refreshUsage(configDir: string): Promise<void> {
    if (process.env['AGENTS_NO_USAGE_FETCH'] || this.probing.has(configDir)) return
    this.probing.add(configDir)
    try {
      const usage = await fetchUsage(configDir) // best-effort (scrapes claude /usage)
      // Full replace, but NEVER let a routine scrape lift a live banner-set park:
      // markRateLimited() itself kicks a probe, and a per-model/Opus limit fires a
      // banner while the panel still reads < 100%. Clearing the park here bounced
      // the session straight back onto the limited account — an endless switch
      // loop. The park expires on its own at limitedUntil (the window reset).
      if (usage) this.update(configDir, { usage: { ...usage, limitedUntil: this.livePark(configDir) ?? usage.limitedUntil } })
    } finally {
      this.probing.delete(configDir)
    }
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
   *  claude process). Called lazily when the Settings/accounts view opens,
   *  never on startup. */
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
    this.update(configDir, {
      usage: { ...account.usage, ...usage, limitedUntil: this.livePark(configDir), updatedAt: Date.now() }
    })
  }

  /** A session on this account just saw claude's "limit hit" banner. Remember
   *  the exhaustion until the known 5h reset (or briefly, when unknown) so
   *  pickWithHeadroom can't bounce straight back to it on stale numbers, and
   *  probe the real state in the background. */
  markRateLimited(configDir: string): void {
    const account = this.get(configDir)
    if (!account) return
    const { resetsAt } = account.usage
    const limitedUntil = resetsAt && resetsAt > Date.now() ? resetsAt : Date.now() + 30 * 60_000
    this.update(configDir, { usage: { ...account.usage, limitedUntil } })
    void this.refreshUsage(configDir)
  }

  /**
   * Utilization of an account's tightest limit window (0-100). Any full window
   * blocks the whole account: 5-hour, weekly, or a per-model weekly cap. A
   * window whose reset time has passed counts as free again (stale data), and a
   * banner-marked exhaustion (limitedUntil) counts as full.
   */
  worstUsedPct(a: Account): number {
    const now = Date.now()
    const eff = (pct: number | null, resetsAt: number | null): number =>
      pct == null || (resetsAt != null && resetsAt <= now) ? 0 : pct
    const u = a.usage
    return Math.max(
      u.limitedUntil != null && u.limitedUntil > now ? 100 : 0,
      eff(u.fiveHour, u.resetsAt),
      eff(u.weekly, u.weeklyResetsAt),
      // a per-model window without its own reset time follows the weekly one
      ...u.weeklyModels.map((m) => eff(m.percent, m.resetsAt ?? u.weeklyResetsAt))
    )
  }

  /**
   * Pick a logged-in account (optionally excluding one) with the most headroom
   * across every limit window. Unknown usage counts as fully available (0%).
   * Returns null when no candidate is logged in. Used both for auto-switch and
   * for auto-selecting an account when a new session leaves it blank.
   */
  pickWithHeadroom(exclude?: string): Account | null {
    const candidates = this.list()
      .filter((a) => a.configDir !== exclude && a.loginStatus === 'logged_in' && this.worstUsedPct(a) < 100)
      .sort((a, b) => this.worstUsedPct(a) - this.worstUsedPct(b))
    return candidates[0] ?? null
  }

  /** Remove the account record AND its config directory (never the default ~/.claude). */
  remove(configDir: string): void {
    this.cancelLogin(configDir)
    this.store.set(
      'accounts',
      this.list().filter((a) => a.configDir !== configDir)
    )
    this.onChange()
    if (resolve(configDir) !== join(homedir(), '.claude')) {
      rmSync(configDir, { recursive: true, force: true })
    }
  }

  // ── login (OAuth) ──────────────────────────────────────────────────────────
  /** in-progress `claude auth login` ptys, keyed by config dir */
  private logins = new Map<string, pty.IPty>()
  private noBrowserDir: string | null = null

  /**
   * A PATH dir with a failing `open` shim. claude launches the browser via a
   * PATH-resolved `open`; when it fails, claude skips the auto-open and falls
   * back to the copy-URL + paste-code flow — exactly what we want (the user
   * opens the link themselves from the dialog). One-time, cached.
   */
  private noBrowserPath(): string {
    if (!this.noBrowserDir) {
      const dir = mkdtempSync(join(tmpdir(), 'agents-nobrowser-'))
      for (const cmd of ['open', 'xdg-open']) {
        const p = join(dir, cmd)
        writeFileSync(p, '#!/bin/sh\nexit 1\n')
        chmodSync(p, 0o755)
      }
      this.noBrowserDir = dir
    }
    return this.noBrowserDir
  }

  /**
   * Start `claude auth login` for an account and resolve with the sign-in URL.
   * The browser is intentionally NOT auto-opened (see noBrowserPath) — the user
   * opens it from the dialog. The pty stays alive waiting for the pasted code.
   */
  async startLogin(configDir: string): Promise<string> {
    this.cancelLogin(configDir)
    const env = await envFor(configDir)
    const bin = await claudePath()
    // Re-cancel right before spawning: React StrictMode (dev) runs the dialog effect
    // twice, so two startLogin calls race. Doing the kill + spawn + set with no await
    // in between guarantees exactly one live login pty — otherwise the URL shown and
    // the pty that receives the pasted code have DIFFERENT OAuth states → "invalid code".
    this.cancelLogin(configDir)
    env['PATH'] = `${this.noBrowserPath()}:${env['PATH'] ?? ''}`
    const proc = pty.spawn(bin, ['auth', 'login'], { name: 'xterm-256color', cols: 100, rows: 30, cwd: scratchCwd(), env })
    this.logins.set(configDir, proc)
    let buf = ''
    let settled = false
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.cancelLogin(configDir)
        reject(new Error('login URL not found'))
      }, 20_000)
      proc.onData((d) => {
        buf += d
        const url = extractLoginUrl(buf)
        if (url && !settled) {
          settled = true
          clearTimeout(timer)
          resolve(url)
        }
      })
      proc.onExit(() => {
        clearTimeout(timer)
        if (this.logins.get(configDir) === proc) this.logins.delete(configDir) // don't clobber a newer login
        // login finished (pasted code, or a browser callback) or was aborted —
        // re-check auth so a success reaches the UI, which auto-closes on logged_in
        if (settled) void this.refreshAuth(configDir)
        else {
          settled = true
          reject(new Error('login process exited before URL'))
        }
      })
    })
  }

  /** Write the pasted code (if the login is still waiting), then verify via auth. */
  async submitLoginCode(configDir: string, code: string): Promise<boolean> {
    const proc = this.logins.get(configDir)
    if (proc) {
      // send the (long) code, then Enter after a beat so the whole line is buffered
      // before submit — an immediate CR can cut a long paste short → "invalid code"
      proc.write(code.trim())
      await sleep(80)
      proc.write('\r')
      await Promise.race([new Promise<void>((r) => proc.onExit(() => r())), sleep(25_000)])
    }
    // the pty may already be gone (it timed out, or a browser callback finished the
    // login) — don't error; just confirm the outcome via auth status
    this.cancelLogin(configDir)
    await this.refreshAuth(configDir)
    return this.get(configDir)?.loginStatus === 'logged_in'
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
    const proc = this.logins.get(configDir)
    if (!proc) return
    this.logins.delete(configDir)
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }

  shutdown(): void {
    for (const dir of [...this.logins.keys()]) this.cancelLogin(dir)
  }

  private update(configDir: string, patch: Partial<Account>): void {
    this.store.set(
      'accounts',
      this.list().map((a) => (a.configDir === configDir ? { ...a, ...patch } : a))
    )
    this.onChange()
  }
}
