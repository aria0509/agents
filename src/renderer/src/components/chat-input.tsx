import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { CornerDownLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useApp } from '@/stores/app'

/**
 * Auxiliary input for a session. Enter submits; Shift+Enter and Cmd+Enter insert
 * a newline. Dropped/pasted files and pasted images are handled window-wide in the
 * preload (works from the terminal too) and land here as paths via the store draft,
 * which is keyed by session so it survives this input being unmounted.
 */
export function ChatInput({ sessionId, autoFocus }: { sessionId: string; autoFocus?: boolean }) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const draft = useApp((s) => s.drafts[sessionId] ?? '')
  const setDraft = useApp((s) => s.setDraft)

  // focus on activate, after xterm has mounted (which would otherwise grab focus)
  useEffect(() => {
    if (!autoFocus) return
    const id = setTimeout(() => inputRef.current?.focus(), 80)
    return () => clearTimeout(id)
  }, [autoFocus])

  const send = (): void => {
    if (!draft.trim()) return
    void window.api.ptySubmit(sessionId, draft)
    setDraft(sessionId, '')
  }

  return (
    <div className="bg-card flex items-end gap-2 rounded-lg border p-2 shadow-lg">
      <textarea
        ref={inputRef}
        autoFocus={autoFocus}
        value={draft}
        onChange={(e) => setDraft(sessionId, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
            e.preventDefault()
            send()
          }
        }}
        placeholder={t('session.inputPlaceholder')}
        rows={Math.min(6, draft.split('\n').length)}
        className="border-input focus-visible:ring-ring/50 flex-1 resize-none rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2"
      />
      <Button size="icon" aria-label={t('session.send')} onClick={send} disabled={!draft.trim()}>
        <CornerDownLeft />
      </Button>
    </div>
  )
}
