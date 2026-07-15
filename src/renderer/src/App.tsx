import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useApp, sortedSessions } from '@/stores/app'
import { SessionGrid } from '@/components/session-grid'
import { NewSessionDialog } from '@/components/new-session-dialog'
import { SettingsDialog } from '@/components/settings-dialog'

function App() {
  const { t } = useTranslation()
  const sessions = useApp((s) => s.sessions)
  const setFocused = useApp((s) => s.setFocused)
  const [newOpen, setNewOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    const unfocus = window.api.onFocusSession((id) => setFocused(id))
    const unsettings = window.api.onOpenSettings(() => setSettingsOpen(true)) // menu Cmd+,
    return () => {
      unfocus()
      unsettings()
    }
  }, [setFocused])

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
          <SessionGrid sessions={sortedSessions(sessions)} />
        )}
      </main>

      <NewSessionDialog open={newOpen} onClose={() => setNewOpen(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}

export default App
