import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, LogOut, Trash2 } from 'lucide-react'
import type { Account } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useApp } from '@/stores/app'

/** Edit an account's note, or delete it (blocked while sessions use it; needs a confirm). */
export function AccountEditDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const { t } = useTranslation()
  const inUse = useApp((s) => s.sessions.filter((x) => x.accountDir === account.configDir).length)
  const [note, setNote] = useState(account.note)
  const [confirming, setConfirming] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [error, setError] = useState('')

  const del = async (): Promise<void> => {
    setError('')
    try {
      await window.api.removeAccount(account.configDir) // removes the record + config dir
      onClose()
    } catch (e) {
      setError(String(e))
    }
  }

  const logout = async (): Promise<void> => {
    setLoggingOut(true)
    await window.api.logout(account.configDir)
    setLoggingOut(false)
    onClose()
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{account.name}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-2">
          <Label htmlFor="edit-note">{t('account.note')}</Label>
          <Input id="edit-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('account.notePlaceholder')} />
        </div>

        {inUse > 0 && <p className="text-destructive text-sm">{t('account.deleteInUse', { count: inUse })}</p>}
        {confirming && (
          <div className="border-destructive/40 bg-destructive/5 grid gap-1 rounded-md border p-3">
            <p className="text-destructive text-sm font-medium">{t('account.deleteConfirm', { name: account.name })}</p>
            <p className="text-muted-foreground text-xs">{t('account.deleteConfirmDir')}</p>
            <code className="text-muted-foreground truncate text-xs">{account.configDir}</code>
          </div>
        )}
        {error && <p className="text-destructive text-sm">{error}</p>}

        <DialogFooter className="sm:justify-between">
          {confirming ? (
            <Button variant="destructive" onClick={() => void del()}>
              <Trash2 /> {t('account.confirmDelete')}
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button variant="ghost" className="text-destructive" disabled={inUse > 0} onClick={() => setConfirming(true)}>
                <Trash2 /> {t('common.delete')}
              </Button>
              {account.loginStatus === 'logged_in' && (
                <Button variant="ghost" disabled={loggingOut} onClick={() => void logout()}>
                  {loggingOut ? <Loader2 className="size-4 animate-spin" /> : <LogOut />} {t('account.logout')}
                </Button>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={confirming ? () => setConfirming(false) : onClose}>
              {t('common.cancel')}
            </Button>
            {!confirming && (
              <Button
                onClick={() => {
                  if (note !== account.note) void window.api.updateAccountNote(account.configDir, note)
                  onClose()
                }}
              >
                {t('common.save')}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
