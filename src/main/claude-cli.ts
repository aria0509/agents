/**
 * All knowledge about the claude CLI lives here: how to find it, how to talk
 * to it, what its output/JSON looks like. Version-sensitive details are
 * isolated in this module.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  writeFileSync,
  mkdirSync,
  copyFileSync,
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  lstatSync,
  symlinkSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import pty from 'node-pty'
import type { AccountUsage } from '../shared/types'

const execFileP = promisify(execFile)
const SHELL = process.env['SHELL'] || '/bin/zsh'

let cachedEnv: Record<string, string> | null = null
let cachedClaudePath: string | null = null

/**
 * GUI apps launched from Finder don't inherit the shell PATH — capture the
 * login-shell environment once and reuse it for every claude invocation.
 */
export async function loginShellEnv(): Promise<Record<string, string>> {
  if (cachedEnv) return cachedEnv
  const { stdout } = await execFileP(SHELL, ['-lic', 'env'], { maxBuffer: 1024 * 1024 })
  const env: Record<string, string> = {}
  let lastKey: string | null = null
  for (const line of stdout.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (m) {
      env[m[1]] = m[2]
      lastKey = m[1]
    } else if (lastKey) {
      env[lastKey] += '\n' + line // multiline value continuation
    }
  }
  // Strip every marker of the *launching* environment. Claude-session vars
  // (CLAUDE_CODE_SESSION_ID / CLAUDECODE / AI_AGENT) make a spawned claude
  // quietly exit as a "nested" session. Terminal-identity vars (TERM_PROGRAM,
  // CURSOR_TRACE_ID, ITERM_* …) leak whichever terminal launched the app and
  // make claude misdetect its host — e.g. TERM_PROGRAM=vscode triggers a VS
  // Code extension auto-install that fails. This app IS the terminal; the
  // launcher's identity is always wrong. CLAUDE_CONFIG_DIR is set per account.
  for (const key of Object.keys(env)) {
    if (
      /^(CLAUDE|CLAUDECODE|ANTHROPIC|AI_AGENT|VSCODE_|ITERM_|GHOSTTY_|KITTY_|WT_|TERM_PROGRAM|CURSOR_TRACE_ID|TERMINAL_EMULATOR|LC_TERMINAL)/.test(
        key
      )
    ) {
      delete env[key]
    }
  }
  // GIT_ASKPASS/SSH_ASKPASS from a VS Code/Cursor terminal is a shim that shells
  // out to the VSCODE_GIT_ASKPASS_* vars we just stripped — left alone it fails on
  // every auth prompt. Drop it so git falls back cleanly to its credential helper.
  for (const key of ['GIT_ASKPASS', 'SSH_ASKPASS']) {
    if (/vscode|cursor/i.test(env[key] ?? '')) delete env[key]
  }
  cachedEnv = env
  return env
}

export async function claudePath(): Promise<string> {
  if (cachedClaudePath) return cachedClaudePath
  const env = await loginShellEnv()
  const { stdout } = await execFileP(SHELL, ['-lic', 'command -v claude'], { env })
  // login shells may print banners (e.g. "Restored session: ...") — take the
  // last line, and only trust it if it looks like a path
  const last = stdout.split('\n').map((l) => l.trim()).filter(Boolean).at(-1)
  cachedClaudePath = last?.startsWith('/') ? last : 'claude'
  return cachedClaudePath
}

/**
 * Env for talking to a specific account. The default profile (~/.claude) must
 * NOT set CLAUDE_CONFIG_DIR: with it set, claude expects .claude.json inside
 * the dir, but the default profile keeps it at ~/.claude.json.
 */
export async function envFor(configDir: string): Promise<Record<string, string>> {
  const env = { ...(await loginShellEnv()) }
  if (resolve(configDir) !== join(homedir(), '.claude')) env['CLAUDE_CONFIG_DIR'] = configDir
  // suppress the "resume from summary?" dialog on old/large `--resume`s (2.1.212:
  // shown past 70min/100k-token thresholds) — it blocks unattended restore, and a
  // queued auto-"continue" could confirm its default and /compact the session
  env['CLAUDE_CODE_RESUME_THRESHOLD_MINUTES'] = '999999999'
  env['CLAUDE_CODE_RESUME_TOKEN_THRESHOLD'] = '999999999'
  return env
}

/**
 * One session registry shared by every account — see linkSessionRegistry().
 * Deliberately outside userData: the symlinks live in the user's real account
 * dirs, so dev and packaged builds must agree on a single target.
 */
const SHARED_SESSION_REGISTRY = join(homedir(), '.agent-s-sessions')

/**
 * Make peer messaging (ListAgents / SendMessage) work ACROSS accounts.
 *
 * Claude finds peer sessions by listing `<configDir>/sessions/<pid>.json` and
 * authenticates with the `peerToken` in the sibling
 * `<pid>.<sha256(socketPath)>.key` — both scoped to CLAUDE_CONFIG_DIR. That
 * scoping is the ONLY thing separating accounts: the sockets themselves sit in
 * a machine-wide /tmp/cc-socks and the wire protocol carries no account
 * identity (verified against 2.1.245). Point every account at one registry and
 * sessions see each other regardless of which account runs them.
 *
 * Best-effort: peer messaging is a bonus, never a reason to fail a spawn.
 */
export function linkSessionRegistry(configDir: string): void {
  const link = join(configDir, 'sessions')
  try {
    mkdirSync(SHARED_SESSION_REGISTRY, { recursive: true, mode: 0o700 })
    const current = lstatSync(link, { throwIfNoEntry: false })
    if (current?.isSymbolicLink()) {
      if (resolve(configDir, readlinkSync(link)) === SHARED_SESSION_REGISTRY) return
      rmSync(link)
    } else if (current) {
      // adopt what is already there — records of live sessions included, they
      // keep writing to the same path and simply follow the link from now on
      for (const entry of readdirSync(link)) {
        renameSync(join(link, entry), join(SHARED_SESSION_REGISTRY, entry))
      }
      rmSync(link, { recursive: true })
    }
    symlinkSync(SHARED_SESSION_REGISTRY, link)
  } catch (err) {
    console.warn(`[registry] shared session registry unavailable for ${configDir}:`, err)
  }
}

let cachedScratchCwd: string | null = null
/**
 * An empty directory to run `claude` in when we only need to TALK to it (usage
 * probe, auth login) rather than work in a project. Running claude in ~ makes
 * it scan the home dir and trips macOS privacy (TCC) prompts — Downloads,
 * Music, OneDrive — all attributed to this app (idea from PR #1). The path must
 * be STABLE across launches: folder trust is recorded per-path in each
 * account's .claude.json, so a fresh mkdtemp per run would re-prompt every
 * launch and grow that file forever. tmpdir() is per-user-stable on macOS; its
 * contents may be purged, so recreate on demand.
 */
export function scratchCwd(): string {
  if (!cachedScratchCwd) {
    cachedScratchCwd = join(tmpdir(), 'agents-scratch-cwd')
    mkdirSync(cachedScratchCwd, { recursive: true })
  }
  return cachedScratchCwd
}

export interface AuthStatus {
  loggedIn: boolean
  email: string | null
  subscriptionType: string | null
}

/** `claude auth status --json` for a given config dir. Retries once — the CLI
 *  occasionally hiccups when several instances start concurrently. */
export async function authStatus(configDir: string, retry = 1): Promise<AuthStatus> {
  const env = await envFor(configDir)
  const bin = await claudePath()
  try {
    // logged out = exit code 1 WITH the JSON still on stdout (2.1.258) — that's
    // an answer, not an error; only a missing JSON block is
    const stdout = await execFileP(bin, ['auth', 'status', '--json'], { env, timeout: 30_000 }).then(
      (r) => r.stdout,
      (e: { stdout?: string }) => {
        if (typeof e.stdout === 'string' && e.stdout.includes('{')) return e.stdout
        throw e
      }
    )
    // tolerate update notices etc. around the JSON block
    const json = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1))
    return {
      loggedIn: json.loggedIn === true,
      email: json.email ?? null,
      subscriptionType: json.subscriptionType ?? null
    }
  } catch (e) {
    if (retry > 0) return authStatus(configDir, retry - 1)
    throw e
  }
}

/** `claude update` — self-update the CLI (run once per app launch). Best-effort:
 *  offline, or an npm-managed install that can't self-update, just logs. */
export async function updateClaudeCli(): Promise<void> {
  try {
    const { stdout } = await execFileP(await claudePath(), ['update'], { env: await loginShellEnv(), timeout: 180_000 })
    console.log('[claude-cli] update:', stdout.trim().split('\n').at(-1))
  } catch (err) {
    console.warn('[claude-cli] update failed:', err)
  }
}

/** Log an account out (`claude auth logout`) for a given config dir. */
export async function claudeLogout(configDir: string): Promise<void> {
  await execFileP(await claudePath(), ['auth', 'logout'], { env: await envFor(configDir), timeout: 30_000 })
}

/**
 * Settings file injected via `--settings`: forwards hooks + statusline to our
 * local hook server. NEVER write into <configDir>/settings.json — profiles may
 * symlink-share it (claude-switch convention).
 */
/** tools whose call IS a dialog waiting on the user (hook matcher syntax) */
const DIALOG_TOOLS = 'AskUserQuestion|ExitPlanMode'

export function writeSessionSettings(
  dir: string,
  sessionId: string,
  hookPort: number,
  overrides?: Record<string, unknown>
): string {
  const post = (event: string): string =>
    `curl -sS -m 3 -X POST --data-binary @- http://127.0.0.1:${hookPort}/e/${sessionId}/${event}`
  const hook = (event: string) => [{ hooks: [{ type: 'command', command: post(event) }] }]
  const settings = {
    // Peer messages between our own sessions are intra-app traffic: deliver
    // them instead of holding them for approval (the CLI holds whenever the
    // two sessions' permission-mode classes differ). Before the overrides —
    // this one is the user's to turn back off.
    crossSessionInbound: 'accept',
    // user overrides next (e.g. {"includeCoAuthoredBy": false}) — our
    // statusLine/hooks always win, session tracking depends on them
    ...overrides,
    statusLine: { type: 'command', command: post('statusline') },
    hooks: {
      SessionStart: hook('SessionStart'),
      UserPromptSubmit: hook('UserPromptSubmit'),
      Stop: hook('Stop'),
      Notification: hook('Notification'),
      // the model changed under the session: a user /model, or an automatic
      // fallback (safeguards refusal / overload) that stopOnFallback reacts to
      PostModelSwitch: hook('PostModelSwitch'),
      // dialogs that wait on the user without raising a Notification event
      PreToolUse: [{ matcher: DIALOG_TOOLS, ...hook('PreToolUse')[0] }],
      PostToolUse: [{ matcher: DIALOG_TOOLS, ...hook('PostToolUse')[0] }]
    }
  }
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.json`)
  writeFileSync(file, JSON.stringify(settings))
  return file
}

/**
 * Move a session transcript from one account's config dir to another, keeping
 * the same `projects/<encoded-cwd>/<sid>.jsonl` layout. Returns the new path.
 * We rely on the hook-provided transcriptPath instead of re-deriving the cwd
 * encoding ourselves.
 */
export function moveTranscript(transcriptPath: string, fromDir: string, toDir: string): string {
  const base = resolve(fromDir)
  const abs = resolve(transcriptPath)
  if (!abs.startsWith(base + '/')) throw new Error('transcript not under account dir')
  const rel = abs.slice(base.length + 1) // projects/<enc>/<sid>.jsonl
  const target = join(resolve(toDir), rel)
  mkdirSync(dirname(target), { recursive: true })
  // the jsonl plus its sidecar dir (<sid>/tool-results, subagent transcripts)
  const sidecar = (p: string): string => p.replace(/\.jsonl$/, '')
  for (const [from, to] of [
    [abs, target],
    [sidecar(abs), sidecar(target)]
  ]) {
    if (!existsSync(from)) continue // nothing written yet; resume will recreate
    try {
      renameSync(from, to)
    } catch {
      cpSync(from, to, { recursive: true }) // cross-device fallback
      rmSync(from, { recursive: true, force: true })
    }
  }
  return target
}

/**
 * Strip ANSI/CSI escapes so text matching is reliable. Claude's TUI positions
 * words with cursor-move codes rather than literal spaces, so patterns below use
 * `\s*` (zero-or-more) between words to tolerate the collapsed result.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC (titles, hyperlinks)
    .replace(/\x1b[()][AB0]/g, '')
}

/**
 * Whether a chunk of pty output indicates the account hit a usage limit.
 * 2.1.228 composes banners as `You've hit your <window> limit` (window ∈
 * session/weekly/Opus/Sonnet/Fable 5/usage credit) plus out-of-credit variants;
 * "fast limit" is only the fast-mode cooldown (the session keeps working on the
 * normal lane) and must NOT match. Older wordings kept for older CLIs. Wording
 * lives here so a CLI change is a one-line fix.
 */
export function detectRateLimit(text: string): { window: string; banner: string } | null {
  const s = stripAnsi(text)
  const m =
    /You.?ve\s*(?:hit|reached)\s*your\s*(?!\s*fast)([\w .$'-]{2,30}?)\s*limit[^\n]{0,60}/i.exec(s) ??
    /(You.?re\s*out\s*of\s*(?:usage\s*credits|extra\s*usage)|Your\s*org\s*is\s*out\s*of\s*usage)[^\n]{0,60}/i.exec(s) ??
    /(usage\s*limit\s*reached|5-hour\s*limit\s*reached|weekly\s*limit\s*reached|Claude\s*usage\s*limit)[^\n]{0,60}/i.exec(s)
  if (!m) return null
  // window: "session" | "weekly" | "opus" | "fable 5" | "usage credit" … (what
  // markRateLimited parks against); banner: the whole line, so a repaint of the
  // same notice (scrolling) is told apart from a new one (new reset time)
  return { window: m[1].replace(/\s+/g, ' ').trim().toLowerCase(), banner: m[0].replace(/\s+/g, ' ').trim() }
}

/**
 * The CLI asking a running SESSION to sign in — its credentials went bad while
 * `claude auth status` still reads them as fine (it only reflects local
 * storage). Same wording as `claude auth login`; chrome, never in a replay.
 */
export function isLoginPrompt(text: string): boolean {
  return /Paste\s*code\s*here\s*if\s*prompted|Opening\s*browser\s*to\s*sign\s*in|Select\s*login\s*method/i.test(stripAnsi(text))
}

/**
 * The trust prompt claude shows the first time an account opens an untrusted
 * folder — e.g. "Quick safety check: Is this a project you created or one you
 * trust?" (older builds: "Security guide" / "trust this folder"). Kept broad so
 * a wording change is a one-line fix — this MUST stay current or account-switch
 * resume hangs on the new account's prompt. ⚠️ The affirmative option is NO
 * LONGER the Enter default (see preselectsExit): a bare Enter now quits claude.
 */
export function isTrustPrompt(text: string): boolean {
  // 2.1.258 also gates project settings that carry commands behind "Managed
  // settings require approval" (Yes, I trust these settings / No, exit) — same
  // shape, same handling
  return /trust\s*this\s*folder|Security\s*guide|safety\s*check|created\s*or\s*one\s*you\s*trust|Do\s*you\s*trust|Managed\s*settings\s*require\s*approval/i.test(
    stripAnsi(text)
  )
}

/**
 * Whether a first-run prompt pre-selects the destructive "No, exit" option, so a
 * bare Enter would QUIT claude and the caller must arrow DOWN onto the
 * affirmative choice first. The current "Quick safety check" trust prompt does
 * exactly this — "❯ No, exit" is the default, "Yes, I trust this folder" the
 * line below (same shape as the bypass disclaimer). Left un-handled, the usage
 * probe gets nothing (per-model/Fable usage never loads) and an account-switch
 * resume dies on the new account. Returns false for screens a plain Enter
 * accepts (theme picker, "Press Enter to continue", non-exiting trust variants).
 */
export function preselectsExit(text: string): boolean {
  const s = stripAnsi(text)
  // the highlighted option carries the ❯ marker — trust that over wording when
  // it's rendered ("No, continue without these permissions" also declines)
  if (/❯\s*(?:\d+\.\s*)?No,/i.test(s)) return true
  if (/❯\s*(?:\d+\.\s*)?Yes,/i.test(s)) return false
  return /No,\s*(?:exit|continue)/i.test(s)
}

/**
 * The notice claude paints after an Esc interrupt ("Interrupted · What should
 * Claude do instead?"). No Stop hook fires for an interrupt, so this is the
 * only sign the turn ended. Conversation text repaints on scroll — callers
 * must pair it with a just-pressed Esc rather than trust it on its own.
 */
export function isInterruptNotice(text: string): boolean {
  return /Interrupted\s*·?\s*What\s*should\s*Claude\s*do\s*instead/i.test(stripAnsi(text))
}

/**
 * The disclaimer claude shows at startup whenever it launches in bypass-
 * permissions mode (we restore it via `--permission-mode bypassPermissions`).
 * claude gates the mode on a `bypassPermissionsModeAccepted` config flag that it
 * only writes on a clean exit — and we SIGKILL on every switch/respawn, so it
 * never persists and this screen returns every time. The pre-selected option is
 * "1. No, exit" (NOT a plain Enter-to-accept like the trust prompt), so the
 * caller must move to "2. Yes, I accept" before confirming. Matched on the
 * warning AND an option line so a resumed transcript merely mentioning the mode
 * can't trip it.
 */
export function isBypassWarning(text: string): boolean {
  const s = stripAnsi(text)
  return /bypass\s*permissions\s*mode/i.test(s) && /Yes,\s*I\s*accept|No,\s*exit/i.test(s)
}

/**
 * Whether the TUI has rendered its interactive input box. Until then, a pasted
 * submission lands in the input buffer but the trailing Enter gets eaten —
 * e.g. while `--resume` is still replaying a transcript (seen live). Signals,
 * any of which suffices (footers vary by state — the interrupted-resume screen
 * shows "bypass permissions on (shift+tab to cycle)" with NO "? for shortcuts"):
 * the shortcut hints, the mode footer, or our own injected statusline marker
 * ("◉ agents · <account>", from hook-server's statuslineText — keep in sync).
 */
export function isTuiReady(text: string): boolean {
  return /\?\s*for\s*shortcuts|Try\s*"|shift\+tab\s*to\s*cycle|◉\s*agents/i.test(stripAnsi(text))
}

/**
 * Current permission mode from TUI output, or null when the buffer carries no
 * signal. The statusline payload does NOT include it (verified 2.1.228), but
 * the input-box footer always names the active mode ("⏸ manual mode on",
 * "⏵⏵ accept edits on", "plan mode on", …) and repaints constantly — so the
 * LAST occurrence in the buffer is the current mode. Values match the CLI's
 * --permission-mode choices.
 */
export function detectPermissionMode(text: string): string | null {
  const s = stripAnsi(text)
  let mode: string | null = null
  for (const m of s.matchAll(/\b(accept\s*edits|bypass\s*permissions)\s*on\b|\b(manual|auto|dontAsk|plan)\s*mode\s*on\b/gi)) {
    if (m[1]) mode = /accept/i.test(m[1]) ? 'acceptEdits' : 'bypassPermissions'
    else mode = /dontask/i.test(m[2]) ? 'dontAsk' : m[2].toLowerCase()
  }
  return mode
}

/**
 * Whether ultracode is active, from TUI output — true/false, or null when the
 * buffer carries no signal. The statusline can't tell (it reports ultracode as
 * plain xhigh, verified 2.1.212), so state comes from the TUI itself:
 * ON — the `✦ ultracode` input-box banner, chrome the TUI only renders while the
 * flag is live (`--resume` transcript replays and scrollback never contain it,
 * unlike the `/effort` confirmation text, which they DO replay). OFF — a
 * confirmation of switching to a plain level. Redraws replay older lines in
 * order, so the LATER of the two signals wins. Case-sensitive on purpose:
 * conversation text quoting these phrases usually differs in case; a rare exact
 * quote mislabels only until the next real signal.
 */
export function detectUltracode(text: string): boolean | null {
  const s = stripAnsi(text)
  const last = (re: RegExp): number => {
    let i = -1
    for (const m of s.matchAll(re)) i = m.index
    return i
  }
  const on = last(/✦\s*ultracode/g)
  const off = last(/Set\s*effort\s*level\s*to\s*(?:low|medium|high|xhigh|max)\b|Effort\s*level\s*set\s*to\s*auto/g)
  return on < 0 && off < 0 ? null : on > off
}

/**
 * Extract the OAuth sign-in URL from `claude auth login` output. The CLI emits it
 * as an OSC-8 terminal hyperlink (`ESC ] 8 ; ; <url> BEL`) — read the URL straight
 * out of that escape so we get one clean copy (the visible text repeats it).
 */
export function extractLoginUrl(text: string): string | null {
  // the link is ~1KB (pty reads chunk at 1KB): insist on the hyperlink's
  // terminator so a chunk split mid-URL can't hand out a truncated link whose
  // PKCE state would never match the waiting process
  const osc = text.match(/\x1b\]8;;(https?:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/)
  if (osc) return osc[1]
  const plain = text.match(/https?:\/\/[^\s'"\x1b\x07]+(?=\s)/)
  return plain ? plain[0] : null
}

// ── usage probe (claude's own /usage panel) ─────────────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Panel reset note → epoch ms. Formats: "6:10pm" (today/tomorrow) or
 *  "Jul 16 at 9pm"; spaces may be collapsed by cursor-positioning codes. */
function parseResetTime(s: string): number | null {
  const m = /(?:([A-Za-z]{3})\s*(\d{1,2})\s*at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(s)
  if (!m) return null
  const [, mon, day, h12, min, ampm] = m
  const d = new Date()
  d.setSeconds(0, 0)
  d.setHours((parseInt(h12, 10) % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0), min ? parseInt(min, 10) : 0)
  const monthIdx = mon ? MONTHS.indexOf(mon.toLowerCase()) : -1
  if (monthIdx >= 0) {
    d.setMonth(monthIdx, parseInt(day, 10))
    if (d.getTime() < Date.now() - 86_400_000) d.setFullYear(d.getFullYear() + 1)
  } else if (d.getTime() <= Date.now()) {
    d.setDate(d.getDate() + 1)
  }
  return d.getTime()
}

interface UsageSection {
  percent: number | null
  resetsAt: number | null
}

/** Read one section's "N% used … Resets <when>" from the text right after its
 *  header (at `start`), scoped to before the next section so a section missing
 *  its own "Resets" line (0% windows have none) doesn't pick up the neighbour's,
 *  and so the footer's "N% of your usage…" lines can't bleed in. Values only
 *  overwrite `into` when present — a partial repaint keeps an earlier render's. */
function readSection(clean: string, start: number, into: UsageSection): void {
  let tail = clean.slice(start, start + 400)
  const next = /Current\s*(session|week)|What.s\s*contributing|Usage\s*credits/i.exec(tail)
  if (next) tail = tail.slice(0, next.index)
  const used = /(\d{1,3})\s*%\s*used/i.exec(tail)
  if (!used) return
  into.percent = parseInt(used[1], 10)
  const resets = /Resets\s*([^()\n]{1,40})/i.exec(tail)
  if (resets) into.resetsAt = parseResetTime(resets[1])
}

/**
 * Parse the /usage panel out of accumulated TUI output. The TUI repaints only
 * changed lines, so ANY render — including the newest — can be partial: a
 * section's header and its numbers may never appear together in the final frame
 * (seen live: the last repaint of the Fable row was just `Fable)…67`, header
 * gone). So never slice to "the last render"; instead walk EVERY occurrence of
 * each header across the whole buffer and let the newest one that carries a
 * value win. Returns null until both the session and weekly sections have
 * rendered their percentages.
 */
export function parseUsagePanel(raw: string): AccountUsage | null {
  const clean = stripAnsi(raw)
  const session: UsageSection = { percent: null, resetsAt: null }
  const weekly: UsageSection = { percent: null, resetsAt: null }
  for (const m of clean.matchAll(/Current\s*session/gi)) readSection(clean, m.index + m[0].length, session)
  for (const m of clean.matchAll(/Current\s*week\s*\(\s*all\s*models\s*\)/gi))
    readSection(clean, m.index + m[0].length, weekly)
  if (session.percent === null || weekly.percent === null) return null

  // per-model weekly windows, e.g. "Current week (Fable)" — keyed by name
  const models = new Map<string, UsageSection>()
  for (const m of clean.matchAll(/Current\s*week\s*\(\s*([^)]+?)\s*\)/gi)) {
    if (/all\s*models/i.test(m[1])) continue
    const name = m[1].replace(/\s+/g, ' ').replace(/\s*only$/i, '') // "(Sonnet only)" → "Sonnet"
    const into = models.get(name) ?? { percent: null, resetsAt: null }
    models.set(name, into)
    readSection(clean, m.index + m[0].length, into)
  }
  return {
    fiveHour: session.percent,
    weekly: weekly.percent,
    resetsAt: session.resetsAt,
    weeklyResetsAt: weekly.resetsAt,
    weeklyModels: [...models]
      .filter(([, v]) => v.percent !== null)
      .map(([name, v]) => ({ name, percent: v.percent!, resetsAt: v.resetsAt })),
    limitedUntil: null,
    updatedAt: Date.now()
  }
}

/**
 * Usage by asking claude itself: spawn the TUI, open /usage, scrape the panel,
 * kill. Slower than an HTTP call (a few seconds) but by definition shows
 * exactly what claude shows, and needs no token juggling — the undocumented
 * oauth usage endpoint silently drifted (returned zeros) and is not to be
 * trusted. Returns null on any failure; live usage still flows from the
 * statusline while a session is active. Retries once — like `authStatus`,
 * concurrently-started CLIs occasionally exit right away.
 */
export async function fetchUsage(configDir: string, retry = 1): Promise<AccountUsage | null> {
  const usage = await probeUsage(configDir)
  if (usage || retry <= 0) return usage
  return fetchUsage(configDir, retry - 1)
}

/** First-run screens the probe can safely advance through with Enter: the
 *  folder-trust prompt and one-time pickers (e.g. the theme picker a profile
 *  shows again after some CLI updates) that sit between spawn and the input
 *  box. Probe-only — in a real session the user answers these themselves. */
function isAdvancePrompt(text: string): boolean {
  return isTrustPrompt(text) || /Choose\s*the\s*text\s*style|Press\s*Enter\s*to\s*continue/i.test(stripAnsi(text))
}

async function probeUsage(configDir: string): Promise<AccountUsage | null> {
  const [bin, env] = await Promise.all([claudePath(), envFor(configDir)])
  const proc = pty.spawn(bin, [], { name: 'xterm-256color', cols: 120, rows: 40, cwd: scratchCwd(), env })
  let buf = ''
  let advances = 0
  let sent = false
  let lastParse = ''
  return new Promise((resolve) => {
    let done = false
    const finish = (usage: AccountUsage | null): void => {
      if (done) return // our own kill() below re-enters via onExit
      done = true
      clearInterval(poll)
      clearTimeout(deadline)
      const debugDir = process.env['AGENTS_USAGE_DEBUG_DIR']
      if (debugDir) {
        try {
          mkdirSync(debugDir, { recursive: true })
          writeFileSync(join(debugDir, `usage-${basename(configDir)}-${Date.now()}.txt`), buf)
        } catch {
          /* debug only */
        }
      }
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
      resolve(usage)
    }
    const deadline = setTimeout(() => finish(parseUsagePanel(buf)), 45_000)
    proc.onData((d) => {
      buf += d
      if (buf.length > 400_000) buf = buf.slice(-200_000)
    })
    proc.onExit(() => finish(null))
    const poll = setInterval(() => {
      if (!sent) {
        if (isTuiReady(buf)) {
          sent = true
          buf = ''
          proc.write('/usage')
          setTimeout(() => {
            try {
              proc.write('\r')
            } catch {
              /* probe already ended */
            }
          }, 250)
        } else if (advances < 5 && isAdvancePrompt(buf)) {
          advances++ // once per screen: clearing buf re-arms for the next one
          const down = preselectsExit(buf) // trust prompt defaults to "❯ No, exit"
          buf = ''
          if (down) proc.write('\x1b[B') // ↓ : No, exit → Yes, I trust this folder
          setTimeout(() => {
            try {
              proc.write('\r') // confirm (a beat after ↓ so the repaint settles)
            } catch {
              /* probe already ended */
            }
          }, down ? 150 : 0)
        }
        return
      }
      // settle: the panel keeps (re)painting while its data loads — finish only
      // once the parsed values hold still across two polls, so a per-model
      // section that renders a beat after session/weekly isn't cut off
      const usage = parseUsagePanel(buf)
      if (!usage) return
      const key = JSON.stringify([usage.fiveHour, usage.weekly, usage.resetsAt, usage.weeklyResetsAt, usage.weeklyModels])
      if (key === lastParse) finish(usage)
      else lastParse = key
    }, 400)
  })
}

/** CLI args for launching a session's claude process. model/effort/mode are all
 *  per-process in the CLI — every respawn (stop→resume, account switch, limit
 *  restart) must carry them back or the session silently reverts to defaults
 *  (live-hit: /effort max degraded to xhigh after a switch). Flags, not slash
 *  commands: `/model` pops a "re-read history?" confirm dialog on resumes. */
export function sessionArgs(opts: {
  settingsFile: string
  launchArgs: string
  resumeSessionId?: string | null
  model?: string | null
  effort?: string | null
  permissionMode?: string | null
  addDirs?: string[]
  appendSystemPrompt?: string | null
}): string[] {
  const args = ['--settings', opts.settingsFile]
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId)
  if (opts.model) args.push('--model', opts.model)
  // the flag only accepts plain levels — ultracode is re-applied via /effort
  if (opts.effort && opts.effort !== 'ultracode') args.push('--effort', opts.effort)
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode)
  for (const d of opts.addDirs ?? []) args.push('--add-dir', expandHome(d))
  // one argv element — content with spaces/newlines needs no shell quoting here
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt)
  const extra = opts.launchArgs.trim()
  if (extra) args.push(...extra.split(/\s+/))
  return args
}

/** no shell in the spawn path, so `~/…` form inputs must be expanded here */
const expandHome = (p: string): string => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

/** Concatenated contents of the session's system-prompt files, read fresh on
 *  every spawn so edits apply on the next start; missing files are skipped. */
export function readSystemPrompt(paths: string[]): string | null {
  const parts: string[] = []
  for (const p of paths) {
    try {
      parts.push(readFileSync(expandHome(p), 'utf8'))
    } catch {
      /* gone/unreadable — skip */
    }
  }
  const joined = parts.join('\n\n').trim()
  return joined || null
}

/** Parse the user's settings-overrides JSON (validated in the form); anything
 *  invalid degrades to undefined here rather than blocking a spawn. */
export function parseSettingsOverrides(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
