/** Shared domain types used by both main and renderer processes. */

/**
 * Login lifecycle of an account. Detected via `claude auth status` (JSON:
 * loggedIn/email/subscriptionType) and via login prompts observed in the pty.
 * `expired`: was logged in before (email known) but auth is no longer valid.
 */
export type LoginStatus = 'unknown' | 'logged_out' | 'logged_in' | 'expired'

/**
 * Percent scale 0-100, matching both sources: statusline
 * `rate_limits.*.used_percentage` and claude's own /usage panel.
 */
export interface AccountUsage {
  /** % used of the current (5-hour) window */
  fiveHour: number | null
  /** % used of the weekly (all-models) window */
  weekly: number | null
  /** epoch ms when the 5-hour window resets */
  resetsAt: number | null
  /** epoch ms when the weekly window resets */
  weeklyResetsAt: number | null
  /** per-model weekly windows (e.g. Fable), from the /usage panel probe only */
  weeklyModels: { name: string; percent: number; resetsAt: number | null }[]
  /** claude showed a "limit hit" banner: treat the account as exhausted until
   *  this time (the window reset, or +30min when unknown). Authoritative — a
   *  usage probe or statusline must NOT lift it early, only its own expiry does,
   *  or auto-switch bounces the session back onto the still-limited account */
  limitedUntil: number | null
  /** epoch ms of last successful refresh */
  updatedAt: number | null
}

/**
 * An account IS a claude config dir. Registering a path that already holds a
 * logged-in config just works; an empty dir can be registered first and logged
 * in later.
 */
export interface Account {
  /** CLAUDE_CONFIG_DIR — the unique key (normalized absolute path) */
  configDir: string
  /** display name: user-set, or claude-switch .profile-name, or dir basename */
  name: string
  /** free-form user note */
  note: string
  /** from `claude auth status` once known */
  email: string | null
  /** e.g. "max" | "pro", from `claude auth status` */
  subscriptionType: string | null
  loginStatus: LoginStatus
  /** epoch ms of the last auth status check */
  authCheckedAt: number | null
  usage: AccountUsage
}

/** What to do when a session's account hits its usage limit. */
export type LimitRule =
  | 'auto-switch' // switch to another logged-in account with headroom and continue
  | 'manual' // notify and wait for the user (also covers plain "do nothing")
  | 'wait-and-continue' // wait for the usage window to reset, then send continue

export type SessionState =
  | 'idle'
  | 'running'
  | 'needs-attention'
  | 'done'
  | 'rate-limited'
  | 'exited'

export interface Session {
  id: string
  /** optional user-set title shown on the card */
  title: string | null
  /** Claude Code's own session id (from SessionStart hook), used for --resume */
  claudeSessionId: string | null
  /** full path to the session jsonl (from SessionStart hook); moved on account switch */
  transcriptPath: string | null
  cwd: string
  /** references Account.configDir */
  accountDir: string
  limitRule: LimitRule
  /** extra CLI args passed to `claude` */
  launchArgs: string[]
  state: SessionState
  /** position in the grid */
  order: number
  poppedOut: boolean
  /** last known values reported by the injected statusline */
  model: string | null
  effort: string | null
  /** model id (e.g. claude-fable-5) — restored via --model on every respawn */
  modelId: string | null
  /** permission mode (manual/auto/acceptEdits/plan/dontAsk/bypassPermissions),
   *  synced from the TUI footer; restored via --permission-mode on respawn */
  mode: string | null
  /** files whose fresh contents are appended to the system prompt at every
   *  spawn (--append-system-prompt) — context that never touches the project */
  systemPromptFiles: string[]
  /** extra directories claude may access (--add-dir) */
  addDirs: string[]
  /** also load those directories' CLAUDE.md
   *  (env CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1) */
  addDirClaudeMd: boolean
  /** JSON object text merged into the generated --settings file ('' = none) */
  settingsJson: string
  /** unsent chat-input draft, persisted so an app restart can't eat typed text */
  draft: string | null
}

export type Theme = 'light' | 'dark' | 'system'
export type Language = 'en' | 'zh-Hant' | 'zh-Hans'
