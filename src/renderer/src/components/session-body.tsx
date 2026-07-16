import { useRef } from 'react'
import { useTerminal } from '@/components/use-terminal'
import { cn } from '@/lib/utils'

/**
 * A session's terminal. Interactive only while active (click it to type
 * directly). File drops are handled window-wide (see lib/drop) and routed to
 * the active chat input.
 */
export function SessionBody({ sessionId, active, fontSize }: { sessionId: string; active: boolean; fontSize?: number }) {
  const termRef = useRef<HTMLDivElement>(null)
  useTerminal(sessionId, termRef, { interactive: active, fontSize })

  return (
    <div className="min-h-0 flex-1 bg-[#1a1a1a]">
      {/* inactive terminals ignore pointer events so a click activates the card */}
      <div ref={termRef} className={cn('h-full cursor-text p-2', !active && 'pointer-events-none')} />
    </div>
  )
}
