import type { SessionState } from '@shared/types'

/** status-dot colour per state — card header and sidebar filter share it */
export const STATE_DOT: Record<SessionState, string> = {
  idle: 'bg-zinc-400',
  running: 'bg-blue-500 animate-pulse',
  'needs-attention': 'bg-amber-500',
  done: 'bg-emerald-500',
  'rate-limited': 'bg-red-500',
  exited: 'bg-zinc-600'
}

/** filter-chip order: the states that want a look first, the quiet ones last */
export const SESSION_STATES: SessionState[] = ['running', 'needs-attention', 'done', 'rate-limited', 'idle', 'exited']
