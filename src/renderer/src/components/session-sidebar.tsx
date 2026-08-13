import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, LayoutGrid } from 'lucide-react'
import type { SessionView } from '@shared/ipc'
import { useApp } from '@/stores/app'
import { cn } from '@/lib/utils'

interface Group {
  cwd: string
  label: string
  count: number
}

/**
 * Label = the cwd's last path segment; when two different cwds collide on the
 * same label, every collider extends by one more leading segment until unique
 * (e.g. "backend" vs "backend" → "p168/backend" vs "im/backend").
 */
export function groupSessions(sessions: SessionView[]): Group[] {
  const byCwd = new Map<string, number>()
  for (const s of sessions) byCwd.set(s.cwd, (byCwd.get(s.cwd) ?? 0) + 1)
  const cwds = [...byCwd.keys()]
  const depth = new Map(cwds.map((c) => [c, 1]))
  const label = (cwd: string): string =>
    cwd
      .split('/')
      .filter(Boolean)
      .slice(-(depth.get(cwd) ?? 1))
      .join('/')
  for (let round = 0; round < 20; round++) {
    const seen = new Map<string, string[]>()
    for (const c of cwds) {
      const l = label(c)
      seen.set(l, [...(seen.get(l) ?? []), c])
    }
    const colliding = [...seen.values()].filter((group) => group.length > 1).flat()
    // stop when unique, or when extending can't help (identical full paths never collide — byCwd keys are unique)
    if (!colliding.length) break
    for (const c of colliding) {
      const segs = c.split('/').filter(Boolean).length
      depth.set(c, Math.min(segs, (depth.get(c) ?? 1) + 1))
    }
  }
  return cwds
    .map((cwd) => ({ cwd, label: label(cwd), count: byCwd.get(cwd) ?? 0 }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** Left nav: sessions grouped by working directory; clicking filters the grid. */
export function SessionSidebar({ sessions }: { sessions: SessionView[] }) {
  const { t } = useTranslation()
  const groupFilter = useApp((s) => s.groupFilter)
  const setGroupFilter = useApp((s) => s.setGroupFilter)
  const groups = useMemo(() => groupSessions(sessions), [sessions])

  const item = (active: boolean): string =>
    cn(
      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
      active ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:bg-accent/50'
    )

  return (
    <nav className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2">
      <button className={item(groupFilter === null)} onClick={() => setGroupFilter(null)}>
        <LayoutGrid className="size-4 shrink-0" />
        <span className="truncate">{t('sessions.groupAll')}</span>
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">{sessions.length}</span>
      </button>
      {groups.map((g) => (
        <button key={g.cwd} className={item(groupFilter === g.cwd)} onClick={() => setGroupFilter(g.cwd)} title={g.cwd}>
          <Folder className="size-4 shrink-0" />
          <span className="truncate">{g.label}</span>
          <span className="text-muted-foreground ml-auto text-xs tabular-nums">{g.count}</span>
        </button>
      ))}
    </nav>
  )
}
