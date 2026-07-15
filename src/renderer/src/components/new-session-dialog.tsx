import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen } from 'lucide-react'
import type { LimitRule } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LaunchArgsInput } from '@/components/launch-args-input'
import { useApp } from '@/stores/app'

const LIMIT_RULES: LimitRule[] = ['auto-switch', 'manual', 'wait-and-continue']
const AUTO = '__auto__'

export function NewSessionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const accounts = useApp((s) => s.accounts)
  const [cwd, setCwd] = useState('')
  const [title, setTitle] = useState('')
  const [accountDir, setAccountDir] = useState(AUTO)
  const [limitRule, setLimitRule] = useState<LimitRule>('auto-switch')
  const [launchArgs, setLaunchArgs] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const create = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await window.api.createSession({
        cwd,
        title,
        accountDir: accountDir === AUTO ? '' : accountDir,
        limitRule,
        launchArgs
      })
      setCwd('')
      setTitle('')
      setLaunchArgs('')
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('sessions.new')}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="cwd">{t('session.cwd')} *</Label>
            <div className="flex gap-2">
              <Input id="cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/project" />
              <Button
                variant="outline"
                size="icon"
                aria-label={t('common.browse')}
                onClick={() => void window.api.pickDirectory().then((p) => p && setCwd(p))}
              >
                <FolderOpen />
              </Button>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="title">{t('session.titleField')}</Label>
            <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('session.titlePlaceholder')} />
          </div>
          <div className="grid gap-2">
            <Label>{t('session.account')}</Label>
            <Select value={accountDir} onValueChange={setAccountDir}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO}>{t('session.accountAuto')}</SelectItem>
                {accounts
                  .filter((a) => a.loginStatus === 'logged_in')
                  .map((a) => (
                    <SelectItem key={a.configDir} value={a.configDir}>
                      {a.name}
                      {a.usage.fiveHour != null ? ` · 5h ${Math.round(a.usage.fiveHour)}%` : ''}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
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
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void create()} disabled={!cwd || busy}>
            {t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
