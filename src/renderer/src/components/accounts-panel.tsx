import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, LogIn, Pencil, RefreshCw, ScanSearch } from 'lucide-react'
import type { Account, LoginStatus } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useApp } from '@/stores/app'
import { hasUsage, timeAgo, usageLines } from '@/lib/usage'
import { AccountEditDialog } from '@/components/account-edit-dialog'
import { AccountLoginDialog } from '@/components/account-login-dialog'

const STATUS_VARIANT: Record<LoginStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  logged_in: 'default',
  logged_out: 'secondary',
  expired: 'destructive',
  unknown: 'outline'
}

function AccountRow({ account, onEdit, onLogin }: { account: Account; onEdit: () => void; onLogin: () => void }) {
  const { t, i18n } = useTranslation()
  const [busy, setBusy] = useState(false)
  const u = account.usage
  const lines = hasUsage(u)
    ? usageLines(u, { current: t('usage.current'), weekly: t('usage.weekly'), reset: t('account.reset') })
    : null
  const loggedIn = account.loginStatus === 'logged_in'
  const checkedText =
    account.authCheckedAt == null
      ? null
      : Date.now() - account.authCheckedAt < 60_000
        ? t('account.justNow')
        : timeAgo(account.authCheckedAt, i18n.language)

  return (
    <div className="flex items-start gap-3 rounded-md border p-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{account.name}</span>
          <Badge variant={STATUS_VARIANT[account.loginStatus]}>{t(`account.status.${account.loginStatus}`)}</Badge>
          {account.subscriptionType && <Badge variant="outline">{account.subscriptionType}</Badge>}
          {account.note && <span className="text-muted-foreground truncate text-xs">— {account.note}</span>}
        </div>
        <div className="text-muted-foreground truncate text-xs">
          {account.configDir}
          {account.email ? ` · ${account.email}` : ''}
        </div>
        {lines && (
          <div className="text-muted-foreground text-xs leading-relaxed">
            {lines.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        )}
        {checkedText && (
          <div className="text-muted-foreground/70 text-xs">
            {t('account.refreshedAt')} {checkedText}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center">
        {loggedIn ? (
          // logged in → re-check status + usage
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('account.refresh')}
            disabled={busy}
            onClick={() =>
              void (async () => {
                setBusy(true)
                await window.api.refreshAuth(account.configDir)
                setBusy(false)
              })()
            }
          >
            <RefreshCw className={busy ? 'animate-spin' : ''} />
          </Button>
        ) : (
          // not logged in → start the OAuth login flow
          <Button variant="ghost" size="icon" aria-label={t('account.login')} onClick={onLogin}>
            <LogIn />
          </Button>
        )}
        <Button variant="ghost" size="icon" aria-label={t('account.edit')} onClick={onEdit}>
          <Pencil />
        </Button>
      </div>
    </div>
  )
}

/** Account list + add form (embedded in the Settings dialog). */
export function AccountsPanel() {
  const { t } = useTranslation()
  const accounts = useApp((s) => s.accounts)
  const [editing, setEditing] = useState<Account | null>(null)
  const [loggingIn, setLoggingIn] = useState<Account | null>(null)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // refresh usage when this panel opens (may prompt once for Keychain access)
  useEffect(() => void window.api.refreshAllUsage(), [])

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-2">
        {accounts.map((a) => (
          <AccountRow key={a.configDir} account={a} onEdit={() => setEditing(a)} onLogin={() => setLoggingIn(a)} />
        ))}
        {accounts.length === 0 && (
          <p className="text-muted-foreground py-2 text-center text-sm">{t('account.empty')}</p>
        )}
      </div>
      <Button variant="secondary" disabled={busy} onClick={() => void run(() => window.api.discoverAccounts())}>
        <ScanSearch /> {t('account.discover')}
      </Button>
      <div className="grid gap-2">
        <Label htmlFor="acc-name">{t('account.name')} *</Label>
        <Input id="acc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="work" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="acc-path">{t('account.path')}</Label>
        <div className="flex gap-2">
          <Input
            id="acc-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={name ? `~/.claude-${name}` : t('account.pathPlaceholder')}
          />
          <Button
            variant="outline"
            size="icon"
            aria-label={t('common.browse')}
            onClick={() => void window.api.pickDirectory().then((p) => p && setPath(p))}
          >
            <FolderOpen />
          </Button>
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="acc-note">{t('account.note')}</Label>
        <Input id="acc-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('account.notePlaceholder')} />
      </div>
      <Button
        disabled={!name || busy}
        onClick={() =>
          void run(async () => {
            await window.api.registerAccount({ name, path, note })
            setName('')
            setPath('')
            setNote('')
          })
        }
      >
        {t('account.add')}
      </Button>
      {error && <p className="text-destructive text-sm">{error}</p>}
      {editing && <AccountEditDialog account={editing} onClose={() => setEditing(null)} />}
      {loggingIn && <AccountLoginDialog account={loggingIn} onClose={() => setLoggingIn(null)} />}
    </div>
  )
}
