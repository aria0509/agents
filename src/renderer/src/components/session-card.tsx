import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, PanelRightOpen, Power, Settings2 } from 'lucide-react'
import type { SessionView } from '@shared/ipc'
import type { SessionState } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useApp, accountName } from '@/stores/app'
import { SessionBody } from '@/components/session-body'
import { ChatInput } from '@/components/chat-input'
import { SessionSettingsDialog } from '@/components/session-settings-dialog'
import { hasUsage, usageLines } from '@/lib/usage'
import { cn } from '@/lib/utils'

const STATE_DOT: Record<SessionState, string> = {
  idle: 'bg-zinc-400',
  running: 'bg-blue-500 animate-pulse',
  'needs-attention': 'bg-amber-500',
  done: 'bg-emerald-500',
  'rate-limited': 'bg-red-500',
  exited: 'bg-zinc-600'
}

export function SessionCard({ session }: { session: SessionView }) {
  const { t } = useTranslation()
  const accounts = useApp((s) => s.accounts)
  const focusedId = useApp((s) => s.focusedId)
  const setFocused = useApp((s) => s.setFocused)
  const cardSize = useApp((s) => s.cardSize)
  const dragOver = useApp((s) => s.dragOverId === session.id)
  const account = accounts.find((a) => a.configDir === session.accountDir)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const active = focusedId === session.id && session.alive && !session.poppedOut
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: session.id })

  const heading = session.title ?? session.cwd.split('/').filter(Boolean).pop() ?? session.cwd
  const usage = account && hasUsage(account.usage)
    ? usageLines(account.usage, { current: t('usage.current'), weekly: t('usage.weekly'), reset: t('account.reset') })
    : null

  // clicking the terminal/body activates a live card, or resumes an exited one;
  // the header (settings etc.) stays independent
  const activateBody = (): void => {
    if (active) return
    if (session.poppedOut) return void window.api.focusPoppedOut(session.id)
    if (!session.alive) void window.api.restartSession(session.id)
    setFocused(session.id)
  }

  return (
    <div
      ref={setNodeRef}
      data-session-id={session.id}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className={cn('relative', active && 'z-20')}
      onClick={(e) => e.stopPropagation()} // a click on the card never deactivates
    >
      <div
        className={cn(
          'group bg-card relative flex flex-col overflow-hidden rounded-lg border transition-colors',
          dragOver
            ? 'border-primary ring-primary ring-2'
            : active
              ? 'border-ring ring-ring/30 ring-2'
              : 'hover:border-ring/40'
        )}
        style={{ height: cardSize }}
      >
        {/* drop-zone hint, pinned to the bottom + pointing down at the chat input
            (that's where the path lands) rather than centered over the terminal */}
        {dragOver && (
          <div className="bg-primary/5 pointer-events-none absolute inset-0 z-40 flex items-end justify-center pb-2">
            <span className="bg-primary text-primary-foreground rounded-full px-3 py-1 text-xs font-medium shadow">
              {t('session.dropHint')} ↓
            </span>
          </div>
        )}
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span
            className="cursor-grab text-zinc-400 opacity-0 group-hover:opacity-100"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-4" />
          </span>
          <span className={cn('size-2 shrink-0 rounded-full', STATE_DOT[session.state])} />
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{heading}</div>
                <div className="text-muted-foreground truncate text-xs">
                  {accountName(accounts, session.accountDir)}
                  {session.model ? ` · ${session.model}` : ''}
                  {session.effort ? ` · ${session.effort}` : ''}
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              <div>{session.cwd}</div>
              <div>{t(`session.state.${session.state}`)}</div>
              {usage?.map((line) => <div key={line}>{line}</div>)}
            </TooltipContent>
          </Tooltip>
          <div className="flex shrink-0 items-center opacity-0 group-hover:opacity-100">
            {session.alive && (
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t('session.popOut')}
                onClick={() => void window.api.popOutSession(session.id)}
              >
                <PanelRightOpen className="size-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t('session.settings')}
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 className="size-3.5" />
            </Button>
            {/* stop a running session → it becomes an "exited, click to resume" card */}
            {session.alive && (
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-destructive"
                aria-label={t('session.stop')}
                onClick={() => void window.api.stopSession(session.id)}
              >
                <Power className="size-3.5" />
              </Button>
            )}
          </div>
        </div>

        {/* body: terminal + exited/popped overlay, both below the (clickable) header */}
        <div className="relative flex min-h-0 flex-1 flex-col" onClick={activateBody}>
          <SessionBody sessionId={session.poppedOut ? '' : session.id} active={active} fontSize={12} />
          {(session.state === 'exited' || session.poppedOut) && (
            <div className="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/50 text-sm text-zinc-300">
              {session.poppedOut ? t('session.poppedOutHint') : t('session.exitedHint')}
            </div>
          )}
        </div>
      </div>

      {/* chat input floats below the card, outside it; rings while dragging a file
          over the card so it's clear the dropped path lands here */}
      {active && (
        <div className={cn('absolute inset-x-0 top-full z-30 mt-2 rounded-lg', dragOver && 'ring-primary ring-2')}>
          <ChatInput sessionId={session.id} autoFocus />
        </div>
      )}
      {settingsOpen && <SessionSettingsDialog sessionId={session.id} onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
