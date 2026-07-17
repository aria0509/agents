/**
 * All knowledge about the claude CLI lives here: how to find it, how to talk
 * to it, what its output/JSON looks like. Version-sensitive details are
 * isolated in this module.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync, mkdirSync, copyFileSync, existsSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
  // Strip every marker of the *launching* claude session. If the app itself is
  // started from inside a Claude Code session, the login shell inherits vars
  // like CLAUDE_CODE_SESSION_ID / CLAUDECODE / AI_AGENT; a claude we spawn would
  // see them and quietly exit as a "nested" session. We set CLAUDE_CONFIG_DIR
  // ourselves per account, so drop any inherited one too.
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE|CLAUDECODE|ANTHROPIC|AI_AGENT)/.test(key)) delete env[key]
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
    const { stdout } = await execFileP(bin, ['auth', 'status', '--json'], { env, timeout: 30_000 })
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

/** Log an account out (`claude auth logout`) for a given config dir. */
export async function claudeLogout(configDir: string): Promise<void> {
  await execFileP(await claudePath(), ['auth', 'logout'], { env: await envFor(configDir), timeout: 30_000 })
}

/**
 * Settings file injected via `--settings`: forwards hooks + statusline to our
 * local hook server. NEVER write into <configDir>/settings.json — profiles may
 * symlink-share it (claude-switch convention).
 */
export function writeSessionSettings(dir: string, sessionId: string, hookPort: number): string {
  const post = (event: string): string =>
    `curl -sS -m 3 -X POST --data-binary @- http://127.0.0.1:${hookPort}/e/${sessionId}/${event}`
  const hook = (event: string) => [{ hooks: [{ type: 'command', command: post(event) }] }]
  const settings = {
    statusLine: { type: 'command', command: post('statusline') },
    hooks: {
      SessionStart: hook('SessionStart'),
      UserPromptSubmit: hook('UserPromptSubmit'),
      Stop: hook('Stop'),
      Notification: hook('Notification')
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
  if (!existsSync(abs)) return target // nothing written yet; resume will recreate
  try {
    renameSync(abs, target)
  } catch {
    copyFileSync(abs, target) // cross-device fallback
    rmSync(abs, { force: true })
  }
  return target
}

/**
 * Strip ANSI/CSI escapes so text matching is reliable. Claude's TUI positions
 * words with cursor-move codes rather than literal spaces, so patterns below use
 * `\s*` (zero-or-more) between words to tolerate the collapsed result.
 */
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC (titles, hyperlinks)
    .replace(/\x1b[()][AB0]/g, '')
}

/**
 * Whether a chunk of pty output indicates the account hit its usage limit.
 * Wording lives here so a CLI change is a one-line fix. Kept broad on purpose.
 */
export function detectRateLimit(text: string): boolean {
  return /(usage\s*limit\s*reached|reached\s*your\s*usage\s*limit|5-hour\s*limit\s*reached|weekly\s*limit\s*reached|Claude\s*usage\s*limit)/i.test(
    stripAnsi(text)
  )
}

/**
 * The trust prompt claude shows the first time an account opens an untrusted
 * folder — e.g. "Quick safety check: Is this a project you created or one you
 * trust?" (older builds: "Security guide" / "trust this folder"). Enter accepts
 * the pre-selected "yes". Kept broad so a wording change is a one-line fix — this
 * MUST stay current or account-switch resume hangs on the new account's prompt.
 */
export function isTrustPrompt(text: string): boolean {
  return /trust\s*this\s*folder|Security\s*guide|safety\s*check|created\s*or\s*one\s*you\s*trust|Do\s*you\s*trust/i.test(
    stripAnsi(text)
  )
}

/** `claude --resume <id>` failed because the transcript is gone/incompatible. */
export function detectNoConversation(text: string): boolean {
  return /No\s*conversation\s*found/i.test(stripAnsi(text))
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
  const osc = text.match(/\x1b\]8;;(https?:\/\/[^\x07\x1b]+)/)
  if (osc) return osc[1]
  const plain = text.match(/https?:\/\/[^\s'"\x1b\x07]+/)
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

/** "<header> … N% used … Resets <when>", scoped to before the next section
 *  header so a section missing its own "Resets" line (0% windows have none)
 *  doesn't pick up the neighbour's. */
function usageSection(text: string, header: RegExp): { percent: number | null; resetsAt: number | null } {
  const m = header.exec(text)
  if (!m) return { percent: null, resetsAt: null }
  let tail = text.slice(m.index + m[0].length, m.index + m[0].length + 500)
  const next = /Current\s*(session|week)/i.exec(tail)
  if (next) tail = tail.slice(0, next.index)
  const used = /(\d{1,3})\s*%\s*used/i.exec(tail)
  const resets = /Resets\s*([^()\n]{1,40})/i.exec(tail)
  return {
    percent: used ? parseInt(used[1], 10) : null,
    resetsAt: resets ? parseResetTime(resets[1]) : null
  }
}

/**
 * Parse the /usage panel out of accumulated TUI output. The TUI redraws, so the
 * buffer holds several renders — parse only the last one. Returns null until
 * both the session and weekly sections have rendered their percentages.
 */
export function parseUsagePanel(raw: string): AccountUsage | null {
  const clean = stripAnsi(raw)
  let last = -1
  for (let m, re = /Current\s*session/gi; (m = re.exec(clean)); ) last = m.index
  if (last < 0) return null
  const text = clean.slice(last)

  const session = usageSection(text, /Current\s*session/i)
  const weekly = usageSection(text, /Current\s*week\s*\(\s*all\s*models\s*\)/i)
  if (session.percent === null || weekly.percent === null) return null

  // partial TUI redraws can repeat a section — the Map keeps the last (newest)
  const models = new Map<string, number>()
  for (let m, re = /Current\s*week\s*\(\s*([^)]+?)\s*\)/gi; (m = re.exec(text)); ) {
    if (/all\s*models/i.test(m[1])) continue
    const used = /(\d{1,3})\s*%\s*used/i.exec(text.slice(m.index + m[0].length, m.index + m[0].length + 500))
    if (used) models.set(m[1].replace(/\s+/g, ' '), parseInt(used[1], 10))
  }
  const weeklyModels = [...models].map(([name, percent]) => ({ name, percent }))
  return {
    fiveHour: session.percent,
    weekly: weekly.percent,
    resetsAt: session.resetsAt,
    weeklyResetsAt: weekly.resetsAt,
    weeklyModels,
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

async function probeUsage(configDir: string): Promise<AccountUsage | null> {
  const [bin, env] = await Promise.all([claudePath(), envFor(configDir)])
  const proc = pty.spawn(bin, [], { name: 'xterm-256color', cols: 120, rows: 40, cwd: homedir(), env })
  let buf = ''
  let trusted = false
  let sent = false
  let settling = false
  return new Promise((resolve) => {
    const finish = (usage: AccountUsage | null): void => {
      clearInterval(poll)
      clearTimeout(deadline)
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
      const text = stripAnsi(buf)
      if (!trusted && isTrustPrompt(text)) {
        trusted = true
        buf = ''
        proc.write('\r')
        return
      }
      if (!sent) {
        if (/\?\s*for\s*shortcuts|Try\s*"/i.test(text)) {
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
        }
        return
      }
      if (!settling && parseUsagePanel(buf)) {
        settling = true // panel is up — give it one more beat to finish rendering
        setTimeout(() => finish(parseUsagePanel(buf)), 1_200)
      }
    }, 400)
  })
}

/** CLI args for launching a session's claude process. */
export function sessionArgs(opts: {
  settingsFile: string
  launchArgs: string
  resumeSessionId?: string | null
}): string[] {
  const args = ['--settings', opts.settingsFile]
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId)
  const extra = opts.launchArgs.trim()
  if (extra) args.push(...extra.split(/\s+/))
  return args
}
