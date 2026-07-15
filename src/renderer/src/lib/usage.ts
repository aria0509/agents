import type { AccountUsage } from '@shared/types'

export const hasUsage = (u: AccountUsage): boolean => u.fiveHour != null || u.weekly != null

const pct = (v: number | null): string => (v == null ? '–' : `${Math.round(v)}%`)

/** human "time until" a reset epoch, or null if unknown/past */
export function resetIn(resetsAt: number | null): string | null {
  if (!resetsAt) return null
  const ms = resetsAt - Date.now()
  if (ms <= 0) return null
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (h >= 24) return `${Math.floor(h / 24)}d${h % 24}h`
  return h ? `${h}h${m}m` : `${m}m`
}

/**
 * The two usage lines in claude's /usage format, shared everywhere usage shows:
 *   current  X% · reset Y
 *   weekly   X% · Fable Z% · reset W
 */
export function usageLines(u: AccountUsage, L: { current: string; weekly: string; reset: string }): string[] {
  const withReset = (r: number | null): string => (resetIn(r) ? ` · ${L.reset} ${resetIn(r)}` : '')
  const current = `${L.current} ${pct(u.fiveHour)}${withReset(u.resetsAt)}`
  // weeklyModels can be absent (statusline-sourced usage, or older persisted data)
  const models = (u.weeklyModels ?? []).map((m) => ` · ${m.name} ${m.percent}%`).join('')
  const weekly = `${L.weekly} ${pct(u.weekly)}${models}${withReset(u.weeklyResetsAt)}`
  return [current, weekly]
}
