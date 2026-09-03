import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useApp, sortedSessions } from '@/stores/app'
import { SessionGrid } from '@/components/session-grid'
import { SessionSidebar } from '@/components/session-sidebar'
import { StateFilter } from '@/components/state-filter'
import { NewSessionDialog } from '@/components/new-session-dialog'
import { SettingsDialog } from '@/components/settings-dialog'

function App() {
  const { t } = useTranslation()
  const sessions = useApp((s) => s.sessions)
  const setFocused = useApp((s) => s.setFocused)
  const groupFilter = useApp((s) => s.groupFilter)
  const setGroupFilter = useApp((s) => s.setGroupFilter)
  const stateFilter = useApp((s) => s.stateFilter)
  const setStateFilter = useApp((s) => s.setStateFilter)
  const flash = useApp((s) => s.flash)
  const [newOpen, setNewOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    // a notification click (main → EVENT_FOCUS_SESSION): make the card visible
    // whatever the filters say, activate it, scroll to it and flash it
    const unfocus = window.api.onFocusSession((id) => {
      const s = useApp.getState()
      const target = s.sessions.find((x) => x.id === id)
      if (target && s.groupFilter && s.groupFilter !== target.cwd) setGroupFilter(null)
      if (target && s.stateFilter && s.stateFilter !== target.state) setStateFilter(null)
      setFocused(id)
      flash(id)
      setTimeout(() => document.querySelector(`[data-session-id="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60)
    })
    const unsettings = window.api.onOpenSettings(() => setSettingsOpen(true)) // menu Cmd+,
    return () => {
      unfocus()
      unsettings()
    }
  }, [setFocused, setGroupFilter, setStateFilter, flash])

  // a filtered group whose last session was removed falls back to "all"
  useEffect(() => {
    if (groupFilter && !sessions.some((s) => s.cwd === groupFilter)) setGroupFilter(null)
  }, [sessions, groupFilter, setGroupFilter])

  // folder filter (sidebar) first, then the state chips over what's left. A state
  // filter stays put when its count drops to zero (states change under the user
  // constantly) — the empty grid says so instead
  const inFolder = groupFilter ? sessions.filter((s) => s.cwd === groupFilter) : sessions
  const visible = stateFilter ? inFolder.filter((s) => s.state === stateFilter) : inFolder

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-12 shrink-0 items-center border-b pr-3 pl-20 [-webkit-app-region:drag]">
        <span className="text-sm font-semibold">{t('appName')}</span>
        <div className="ml-auto flex items-center gap-1 [-webkit-app-region:no-drag]">
          <Button variant="ghost" size="sm" onClick={() => setNewOpen(true)}>
            <Plus /> {t('sessions.new')}
          </Button>
          <Button variant="ghost" size="icon" aria-label={t('settings.title')} onClick={() => setSettingsOpen(true)}>
            <Settings />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {sessions.length > 0 && <SessionSidebar sessions={sessions} />}
        <main className="min-h-0 flex-1 overflow-y-auto p-4" onClick={() => setFocused(null)}>
          {sessions.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <p className="text-lg font-medium">{t('sessions.empty')}</p>
              <p className="text-muted-foreground text-sm">{t('sessions.emptyHint')}</p>
              <Button className="mt-2" onClick={() => setNewOpen(true)}>
                <Plus /> {t('sessions.new')}
              </Button>
            </div>
          ) : (
            <>
              <StateFilter sessions={inFolder} />
              {visible.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t('sessions.noMatch')}</p>
              ) : (
                <SessionGrid sessions={sortedSessions(visible)} />
              )}
            </>
          )}
        </main>
      </div>

      <NewSessionDialog open={newOpen} onClose={() => setNewOpen(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}

export default App
