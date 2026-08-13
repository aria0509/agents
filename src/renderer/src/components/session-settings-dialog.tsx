import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
import type { LimitRule } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LaunchArgsInput } from '@/components/launch-args-input'
import { useApp, accountOptionLabel } from '@/stores/app'

const LIMIT_RULES: LimitRule[] = ['auto-switch', 'manual', 'wait-and-continue']
/** display-name → model id; "default" keeps whatever the CLI decides */
const MODELS = [
  ['Fable 5', 'claude-fable-5'],
  ['Opus 5', 'claude-opus-5'],
  ['Sonnet 5', 'claude-sonnet-5'],
  ['Haiku 4.5', 'claude-haiku-4-5']
] as const
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const
const MODES = ['manual', 'auto', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'] as const
const DEFAULT = '__default__' // Select can't take '' as an item value

/** Edit a session's title, account (only while idle), model/effort/mode, limit
 *  rule, launch args; delete lives here too. Values also follow in-CLI changes
 *  (statusline / footer sync), so the dialog always shows the live state. */
export function SessionSettingsDialog({ sessionId, onClose }: { sessionId: string | null; onClose: () => void }) {
  const { t } = useTranslation()
  const accounts = useApp((s) => s.accounts)
  const session = useApp((s) => s.sessions.find((x) => x.id === sessionId))

  const [title, setTitle] = useState('')
  const [accountDir, setAccountDir] = useState('')
  const [limitRule, setLimitRule] = useState<LimitRule>('auto-switch')
  const [launchArgs, setLaunchArgs] = useState('')
  const [modelId, setModelId] = useState(DEFAULT)
  const [effort, setEffort] = useState(DEFAULT)
  const [mode, setMode] = useState(DEFAULT)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!session) return
    setTitle(session.title ?? '')
    setAccountDir(session.accountDir)
    setLimitRule(session.limitRule)
    setLaunchArgs(session.launchArgs.join(' '))
    setModelId(session.modelId ?? DEFAULT)
    setEffort(session.effort ?? DEFAULT)
    setMode(session.mode ?? DEFAULT)
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
        title,
        limitRule,
        launchArgs,
        modelId: modelId === DEFAULT ? null : modelId,
        effort: effort === DEFAULT ? null : effort,
        mode: mode === DEFAULT ? null : mode
      })
      if (accountDir !== session.accountDir) await window.api.switchAccount(session.id, accountDir)
      onClose()
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{t('session.settings')}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="s-title">{t('session.titleField')}</Label>
            <Input id="s-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('session.titlePlaceholder')} />
          </div>
          <div className="grid gap-2">
            <Label>
              {t('session.account')}
              {running && <span className="text-muted-foreground ml-2 text-xs">{t('session.switchWhenIdle')}</span>}
            </Label>
            <Select value={accountDir} onValueChange={setAccountDir} disabled={running}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.configDir} value={a.configDir}>
                    {accountOptionLabel(a, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="grid gap-2">
              <Label>{t('session.model')}</Label>
              <Select value={modelId} onValueChange={setModelId}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT}>{t('session.optionDefault')}</SelectItem>
                  {MODELS.map(([name, id]) => (
                    <SelectItem key={id} value={id}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>{t('session.effort')}</Label>
              <Select value={effort} onValueChange={setEffort}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT}>{t('session.optionDefault')}</SelectItem>
                  {EFFORTS.map((e) => (
                    <SelectItem key={e} value={e}>
                      {e}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>{t('session.mode')}</Label>
              <Select value={mode} onValueChange={setMode}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT}>{t('session.optionDefault')}</SelectItem>
                  {MODES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {t(`session.modes.${m}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-muted-foreground -mt-2 text-xs">{t('session.modelEffortHint')}</p>
          <div className="grid gap-2">
            <Label>{t('session.limitRule')}</Label>
            <Select value={limitRule} onValueChange={(v) => setLimitRule(v as LimitRule)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIMIT_RULES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {t(`limitRule.${r}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="args">{t('session.launchArgs')}</Label>
            <LaunchArgsInput id="args" value={launchArgs} onChange={setLaunchArgs} />
            <p className="text-muted-foreground text-xs">{t('session.launchArgsHint')}</p>
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>
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
            <Button onClick={() => void save()}>{t('common.save')}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
