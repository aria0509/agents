/**
 * All knowledge about the claude CLI lives here: how to find it, how to talk
 * to it, what its output/JSON looks like. Version-sensitive details are
 * isolated in this module.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync, mkdirSync, copyFileSync, existsSync, renameSync, rmSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
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
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b[()][AB0]/g, '')
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
 * The trust prompt claude shows the first time it opens an untrusted folder
 * ("Security guide" / "Yes, I trust this folder", Enter pre-confirms).
 */
export function isTrustPrompt(text: string): boolean {
  return /trust\s*this\s*folder|Security\s*guide/i.test(stripAnsi(text))
}

/** `claude --resume <id>` failed because the transcript is gone/incompatible. */
export function detectNoConversation(text: string): boolean {
  return /No\s*conversation\s*found/i.test(stripAnsi(text))
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

/**
 * Read an account's OAuth access token. Claude stores it either in
 * `<configDir>/.credentials.json` (file) or, on macOS, the Keychain under
 * `Claude Code-credentials[-<sha256(configDir)[:8]>]` (the default profile has
 * no suffix). The Keychain read triggers a one-time macOS permission prompt.
 */
async function readToken(configDir: string): Promise<string | null> {
  try {
    const creds = JSON.parse(readFileSync(join(configDir, '.credentials.json'), 'utf8'))
    if (creds?.claudeAiOauth?.accessToken) return creds.claudeAiOauth.accessToken
  } catch {
    /* fall through to keychain */
  }
  if (process.platform !== 'darwin') return null
  const isDefault = resolve(configDir) === join(homedir(), '.claude')
  const hash = createHash('sha256').update(resolve(configDir)).digest('hex').slice(0, 8)
  const service = isDefault ? 'Claude Code-credentials' : `Claude Code-credentials-${hash}`
  try {
    const { stdout } = await execFileP('security', ['find-generic-password', '-s', service, '-w'], { timeout: 20_000 })
    return JSON.parse(stdout.trim())?.claudeAiOauth?.accessToken ?? null
  } catch {
    return null
  }
}

interface UsageLimit {
  kind?: string
  percent?: number
  resets_at?: string
  scope?: { model?: { display_name?: string } }
}

/**
 * Usage via the (undocumented) oauth usage endpoint, in the same shape claude's
 * own /usage panel shows: current % + reset, weekly all-models % + reset, and
 * per-model weekly (e.g. Fable). Returns null on any failure; live usage still
 * flows from the statusline while a session is active.
 */
export async function fetchUsage(configDir: string): Promise<AccountUsage | null> {
  const token = await readToken(configDir)
  if (!token) return null
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }
    })
    if (!res.ok) return null
    const j = (await res.json()) as {
      five_hour?: { utilization?: number; resets_at?: string }
      seven_day?: { utilization?: number; resets_at?: string }
      limits?: UsageLimit[]
    }
    const iso = (s?: string): number | null => (s ? new Date(s).getTime() : null)
    const limits = j.limits ?? []
    const session = limits.find((l) => l.kind === 'session')
    const weeklyAll = limits.find((l) => l.kind === 'weekly_all')
    const weeklyModels = limits
      .filter((l) => l.kind === 'weekly_scoped' && l.scope?.model?.display_name)
      .map((l) => ({ name: l.scope!.model!.display_name!, percent: Math.round(l.percent ?? 0) }))
    return {
      fiveHour: session?.percent ?? j.five_hour?.utilization ?? null,
      weekly: weeklyAll?.percent ?? j.seven_day?.utilization ?? null,
      resetsAt: iso(session?.resets_at ?? j.five_hour?.resets_at),
      weeklyResetsAt: iso(weeklyAll?.resets_at ?? j.seven_day?.resets_at),
      weeklyModels,
      updatedAt: Date.now()
    }
  } catch {
    return null
  }
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
