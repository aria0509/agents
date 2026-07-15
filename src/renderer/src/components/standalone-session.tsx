import { useTranslation } from 'react-i18next'
import { useApp, accountName } from '@/stores/app'
import { SessionBody } from '@/components/session-body'
import { ChatInput } from '@/components/chat-input'
import { hasUsage, usageLines } from '@/lib/usage'

/** Whole-window view of a single session, rendered in a pop-out window. */
export function StandaloneSession({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const accounts = useApp((s) => s.accounts)
  const session = useApp((s) => s.sessions.find((x) => x.id === sessionId))
  const dragOver = useApp((s) => s.dragOverId === sessionId)
  const account = accounts.find((a) => a.configDir === session?.accountDir)

  if (!session) {
    return (
      <div className="text-muted-foreground flex h-screen items-center justify-center text-sm">
        {t('session.exitedHint')}
      </div>
    )
  }

  const heading = session.title ?? session.cwd.split('/').filter(Boolean).pop() ?? session.cwd
  const usage =
    account && hasUsage(account.usage)
      ? usageLines(account.usage, { current: t('usage.current'), weekly: t('usage.weekly'), reset: t('account.reset') })
      : null

  return (
    <div className="relative flex h-screen flex-col" data-session-id={sessionId}>
      {dragOver && (
        <div className="ring-primary pointer-events-none absolute inset-0 z-50 flex items-end justify-center rounded-sm pb-24 ring-2 ring-inset">
          <span className="bg-primary text-primary-foreground rounded-full px-3 py-1 text-xs font-medium">
            {t('session.dropHint')}
          </span>
        </div>
      )}
      {/* left→right: (1) title / work dir  (2) model / effort  (3) account + usage.
          pl-20 clears the macOS traffic-light buttons */}
      <div className="flex h-14 shrink-0 items-center gap-6 border-b pr-4 pl-20 text-xs leading-tight [-webkit-app-region:drag]">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{heading}</div>
          <div className="text-muted-foreground truncate">{session.cwd}</div>
        </div>
        <div className="text-muted-foreground min-w-0">
          <div className="truncate">{session.model ?? '—'}</div>
          <div className="truncate">{session.effort ?? '—'}</div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <div className="font-medium">{accountName(accounts, session.accountDir)}</div>
          {usage && (
            <div className="text-muted-foreground text-left">
              {usage.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          )}
        </div>
      </div>
      <SessionBody sessionId={sessionId} active />
      <div className="shrink-0 border-t p-2">
        <ChatInput sessionId={sessionId} autoFocus />
      </div>
    </div>
  )
}
