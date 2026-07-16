import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, ExternalLink, Loader2 } from 'lucide-react'
import type { Account } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useApp } from '@/stores/app'

/**
 * OAuth login for one account. Starts `claude auth login` (which also opens the
 * browser), shows the sign-in URL to copy/open, then submits the pasted code.
 * Closing the dialog aborts the in-progress login.
 */
export function AccountLoginDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const { t } = useTranslation()
  const [url, setUrl] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // the account flips to logged_in once login completes (pasted code, or a browser
  // callback) — auto-close the dialog when it does
  const loggedIn = useApp((s) => s.accounts.find((a) => a.configDir === account.configDir)?.loginStatus === 'logged_in')

  useEffect(() => {
    let alive = true
    window.api
      .startLogin(account.configDir)
      .then((u) => alive && setUrl(u))
      .catch((e) => alive && setError(String(e)))
    return () => {
      alive = false
      void window.api.cancelLogin(account.configDir)
    }
  }, [account.configDir])

  useEffect(() => {
    if (loggedIn) onClose()
  }, [loggedIn, onClose])

  const submit = async (): Promise<void> => {
    if (!code.trim()) return
    setSubmitting(true)
    setError('')
    try {
      if (await window.api.submitLoginCode(account.configDir, code)) onClose()
      else setError(t('account.loginFailed'))
    } catch (e) {
      setError(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t('account.login')} · {account.name}
          </DialogTitle>
        </DialogHeader>

        {!url && !error && (
          <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Loader2 className="size-4 animate-spin" /> {t('account.loginStarting')}
          </div>
        )}

        {url && (
          <div className="grid gap-4">
            <p className="text-muted-foreground text-sm">{t('account.loginUrlHint')}</p>
            <div className="flex gap-2">
              <Input readOnly value={url} className="text-muted-foreground text-xs" onFocus={(e) => e.target.select()} />
              <Button
                variant="outline"
                size="icon"
                aria-label={t(copied ? 'common.copied' : 'common.copy')}
                onClick={() =>
                  void navigator.clipboard.writeText(url).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  })
                }
              >
                <Copy className={copied ? 'text-emerald-500' : ''} />
              </Button>
              <Button variant="outline" size="icon" aria-label={t('common.open')} onClick={() => window.open(url, '_blank')}>
                <ExternalLink />
              </Button>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="login-code">{t('account.loginCode')}</Label>
              <div className="flex gap-2">
                <Input
                  id="login-code"
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void submit()}
                  placeholder={t('account.loginCodePlaceholder')}
                />
                <Button onClick={() => void submit()} disabled={!code.trim() || submitting}>
                  {submitting ? <Loader2 className="size-4 animate-spin" /> : t('common.submit')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {error && <p className="text-destructive text-sm">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}
