import Store from 'electron-store'
import type { Account, Session } from '../shared/types'

interface Schema {
  accounts: Account[]
  sessions: Session[]
  /** recently used launch-args strings, most-recent first (max 10) */
  recentLaunchArgs: string[]
}

export type AppStore = Store<Schema>

export function createStore(): AppStore {
  return new Store<Schema>({
    defaults: { accounts: [], sessions: [], recentLaunchArgs: [] }
  })
}

const MAX_RECENT = 10

/** Record a launch-args string as most-recently-used (dedup, capped). */
export function pushRecentLaunchArgs(store: AppStore, args: string): void {
  const trimmed = args.trim()
  if (!trimmed) return
  const next = [trimmed, ...(store.get('recentLaunchArgs') ?? []).filter((a) => a !== trimmed)]
  store.set('recentLaunchArgs', next.slice(0, MAX_RECENT))
}
