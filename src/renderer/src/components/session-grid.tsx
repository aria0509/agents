import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, rectSortingStrategy } from '@dnd-kit/sortable'
import type { SessionView } from '@shared/ipc'
import { SessionCard } from '@/components/session-card'
import { useApp } from '@/stores/app'

/** Adaptive, drag-reorderable grid of session cards. */
export function SessionGrid({ sessions }: { sessions: SessionView[] }) {
  const cardSize = useApp((s) => s.cardSize)
  // small activation distance so a click still focuses; only a real drag reorders
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const ids = sessions.map((s) => s.id)

  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    if (!over || active.id === over.id) return
    const next = arrayMove(ids, ids.indexOf(active.id as string), ids.indexOf(over.id as string))
    void window.api.reorderSessions(next)
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        {/* fixed-size cards (width = height = cardSize): a wider window fits MORE
            cards per row rather than stretching them. extra row gap + bottom
            padding leave room for the active card's chat input, which floats below */}
        <div
          className="grid justify-start gap-x-4 gap-y-6 pb-24"
          style={{ gridTemplateColumns: `repeat(auto-fill, ${cardSize}px)` }}
        >
          {sessions.map((s) => (
            <SessionCard key={s.id} session={s} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}
