import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionView } from '@shared/ipc'
import type { SessionState } from '@shared/types'
import { useApp } from '@/stores/app'
import { SESSION_STATES, STATE_DOT } from '@/lib/session-state'
import { cn } from '@/lib/utils'

/** Chip row above the grid: one toggle per session state (plus "all"), with
 *  counts over the sessions the sidebar's folder filter already lets through. */
export function StateFilter({ sessions }: { sessions: SessionView[] }) {
  const { t } = useTranslation()
  const stateFilter = useApp((s) => s.stateFilter)
  const setStateFilter = useApp((s) => s.setStateFilter)
  const counts = useMemo(() => {
    const m = new Map<SessionState, number>()
    for (const s of sessions) m.set(s.state, (m.get(s.state) ?? 0) + 1)
    return m
  }, [sessions])

  const chip = (active: boolean): string =>
    cn(
      'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
      active ? 'bg-accent text-accent-foreground border-ring/40 font-medium' : 'text-muted-foreground hover:bg-accent/50'
    )

  // clicks here must not bubble to <main>, which would unfocus the active card
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <button className={chip(stateFilter === null)} onClick={() => setStateFilter(null)}>
        {t('sessions.groupAll')}
        <span className="tabular-nums opacity-70">{sessions.length}</span>
      </button>
      {SESSION_STATES.map((state) => (
        <button
          key={state}
          className={chip(stateFilter === state)}
          onClick={() => setStateFilter(stateFilter === state ? null : state)}
        >
          <span className={cn('size-2 rounded-full', STATE_DOT[state])} />
          {t(`session.state.${state}`)}
          <span className="tabular-nums opacity-70">{counts.get(state) ?? 0}</span>
        </button>
      ))}
    </div>
  )
}
