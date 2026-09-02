import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  SessionForm,
  emptySessionForm,
  settingsJsonValid,
  splitLines,
  type SessionFormValues
} from '@/components/session-form'

export function NewSessionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const [values, setValues] = useState<SessionFormValues>(emptySessionForm)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const patch = (p: Partial<SessionFormValues>): void => setValues((v) => ({ ...v, ...p }))

  const create = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await window.api.createSession({
        cwd: values.cwd,
        title: values.title,
        accountDir: values.accountDir,
        limitRule: values.limitRule,
        launchArgs: values.launchArgs,
        modelId: values.modelId || null,
        effort: values.effort || null,
        mode: values.mode || null,
        systemPromptFiles: splitLines(values.systemPromptFiles),
        addDirs: splitLines(values.addDirs),
        addDirClaudeMd: values.addDirClaudeMd,
        settingsJson: values.settingsJson.trim(),
        stopOnFallback: values.stopOnFallback
      })
      setValues(emptySessionForm)
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('sessions.new')}</DialogTitle>
        </DialogHeader>
        <SessionForm values={values} onChange={patch} variant="create" />
        {error && <p className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void create()} disabled={!values.cwd || !settingsJsonValid(values.settingsJson) || busy}>
            {t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
