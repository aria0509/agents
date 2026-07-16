import type { AccountUsage } from '@shared/types'

export const hasUsage = (u: AccountUsage): boolean => u.fiveHour != null || u.weekly != null

const pct = (v: number | null): string => (v == null ? '–' : `${Math.round(v)}%`)

/** localized "n minutes/hours/days ago" for a past epoch (ms). Smallest unit is a
 *  minute (callers show "just now" for < 1 min). Null if unknown. */
export function timeAgo(ts: number | null, locale: string): string | null {
  if (!ts) return null
  const s = Math.round((ts - Date.now()) / 1000) // negative = in the past
  const a = Math.abs(s)
  const [v, unit]: [number, Intl.RelativeTimeFormatUnit] =
    a < 3600 ? [s / 60, 'minute'] : a < 86400 ? [s / 3600, 'hour'] : [s / 86400, 'day']
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.min(-1, Math.round(v)), unit)
}

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
