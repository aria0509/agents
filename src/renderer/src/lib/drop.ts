import { useApp } from '@/stores/app'

// pop-out windows load with ?session=<id>; in them we route to that session, not
// the grid, and skip the "focus the pop-out" shortcut (we ARE the pop-out).
const popoutId = new URLSearchParams(location.search).get('session')

const findSessionId = (target: EventTarget | null): string | null => {
  let el = target as HTMLElement | null
  while (el && el.dataset?.sessionId === undefined) el = el.parentElement
  return el?.dataset.sessionId ?? null
}
// real files (Finder) expose 'Files'; VS Code / browsers expose 'text/uri-list'
const isFileDrag = (e: DragEvent): boolean =>
  !!e.dataTransfer && e.dataTransfer.types.some((t) => t === 'Files' || t === 'text/uri-list')

// Drag-zone feedback. Capture phase + `dropEffect='copy'` so the whole card —
// including the xterm terminal — shows a copy cursor and accepts the drop
// (xterm would otherwise leave it as "no drop"). Highlight tracks the hovered card.
window.addEventListener(
  'dragover',
  (e) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    useApp.getState().setDragOverId(findSessionId(e.target) ?? popoutId)
  },
  true
)
window.addEventListener('dragleave', (e) => {
  if (isFileDrag(e) && !e.relatedTarget) useApp.getState().setDragOverId(null) // left the window
})
window.addEventListener('drop', () => useApp.getState().setDragOverId(null), true)

// Files/images dropped or pasted anywhere are resolved to paths in the preload and
// routed here with the card they landed on. Prefill that session's chat-input draft.
window.api.onFileDrop(({ sessionId, paths }) => {
  const s = useApp.getState()
  s.setDragOverId(null)
  const id = sessionId ?? popoutId ?? s.focusedId
  if (!id) return
  const text = paths.join(' ') + ' '
  if (popoutId) return s.appendDraft(id, text) // pop-out window: its input is always mounted
  const session = s.sessions.find((x) => x.id === id)
  if (session?.poppedOut) return void window.api.focusPoppedOut(id) // grid: send to the pop-out window
  s.appendDraft(id, text)
  if (session && !session.alive) void window.api.restartSession(id) // exited → restart so its input mounts
  if (id !== s.focusedId) s.setFocused(id)
})
