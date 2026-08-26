import { useState } from 'react'
import type { SessionView } from '@shared/ipc'
import { cn } from '@/lib/utils'

/**
 * Session title: click to edit in place, blur/Enter saves, Escape cancels.
 * An empty value clears the custom title back to the cwd-basename fallback.
 */
export function EditableTitle({ session, className }: { session: SessionView; className?: string }) {
  const [editing, setEditing] = useState(false)
  const fallback = session.cwd.split('/').filter(Boolean).pop() ?? session.cwd

  if (!editing)
    return (
      <div
        className={cn('cursor-text truncate text-sm font-medium', className)}
        onClick={() => setEditing(true)}
      >
        {session.title ?? fallback}
      </div>
    )

  return (
    <input
      autoFocus
      defaultValue={session.title ?? ''}
      placeholder={fallback}
      className={cn(
        'ring-ring -mx-1 w-full rounded-sm bg-transparent px-1 text-sm font-medium outline-none ring-1',
        className
      )}
      onFocus={(e) => {
        e.stopPropagation() // keep the card tooltip from opening on focus
        e.currentTarget.select()
      }}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        void window.api.updateSessionConfig(session.id, { title: e.currentTarget.value })
        setEditing(false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') setEditing(false) // unmount without blur → no save
      }}
    />
  )
}
