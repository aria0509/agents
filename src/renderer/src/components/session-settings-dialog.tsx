import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  SessionForm,
  emptySessionForm,
  sessionFormValues,
  settingsJsonValid,
  splitLines,
  type SessionFormValues
} from '@/components/session-form'
import { useApp } from '@/stores/app'

/** Edit a session — the same form as "new session" (cwd fixed, account only
 *  while idle). Model/effort/mode also follow in-CLI changes (statusline /
 *  footer sync), so the dialog always shows the live state. */
export function SessionSettingsDialog({ sessionId, onClose }: { sessionId: string | null; onClose: () => void }) {
  const { t } = useTranslation()
  const session = useApp((s) => s.sessions.find((x) => x.id === sessionId))

  const [values, setValues] = useState<SessionFormValues>(emptySessionForm)
  const [error, setError] = useState('')
  const patch = (p: Partial<SessionFormValues>): void => setValues((v) => ({ ...v, ...p }))

  useEffect(() => {
    if (!session) return
    setValues(sessionFormValues(session))
    setError('')
    // sync from the store only when the dialog switches session — not on every
    // state push, or live statusline updates would clobber in-progress edits
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  if (!session) return null
  const running = session.state === 'running'

  const save = async (): Promise<void> => {
    try {
      await window.api.updateSessionConfig(session.id, {
        title: values.title,
        limitRule: values.limitRule,
        launchArgs: values.launchArgs,
        modelId: values.modelId || null,
        effort: values.effort || null,
        mode: values.mode || null,
        systemPromptFiles: splitLines(values.systemPromptFiles),
        addDirs: splitLines(values.addDirs),
        addDirClaudeMd: values.addDirClaudeMd,
        settingsJson: values.settingsJson.trim()
      })
      if (values.accountDir !== session.accountDir) await window.api.switchAccount(session.id, values.accountDir)
      onClose()
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{t('session.settings')}</DialogTitle>
        </DialogHeader>
        <SessionForm values={values} onChange={patch} variant="edit" running={running} />
        {error && <p className="text-destructive text-sm">{error}</p>}
        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            className="text-destructive"
            onClick={() => {
              void window.api.removeSession(session.id)
              onClose()
            }}
          >
            <Trash2 /> {t('session.delete')}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void save()} disabled={!settingsJsonValid(values.settingsJson)}>
              {t('common.save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
