import { create } from 'zustand'
import type { Account, SessionState } from '@shared/types'
import type { AppState, SessionView } from '@shared/ipc'

const CARD_SIZE_KEY = 'agents-card-size'
const clampSize = (n: number): number => Math.min(680, Math.max(340, Math.round(n)))

interface AppStore extends AppState {
  /** the active card (interactive terminal + chat input), or null */
  focusedId: string | null
  setFocused: (id: string | null) => void
  /** grid card size in px (width min + height), adjustable in settings */
  cardSize: number
  setCardSize: (n: number) => void
  /** per-session chat-input drafts (kept here so drops survive an unmounted input) */
  drafts: Record<string, string>
  setDraft: (id: string, text: string) => void
  appendDraft: (id: string, text: string) => void
  /** the card a file is currently being dragged over (drop-zone highlight), or null */
  dragOverId: string | null
  setDragOverId: (id: string | null) => void
  /** sidebar filters: only sessions in this cwd / this state (null = any); both apply */
  groupFilter: string | null
  setGroupFilter: (cwd: string | null) => void
  stateFilter: SessionState | null
  setStateFilter: (state: SessionState | null) => void
}

export const useApp = create<AppStore>((set) => ({
  accounts: [],
  sessions: [],
  recentLaunchArgs: [],
  knownModels: [],
  focusedId: null,
  setFocused: (id) => set({ focusedId: id }),
  cardSize: clampSize(Number(localStorage.getItem(CARD_SIZE_KEY)) || 480),
  setCardSize: (n) => {
    const cardSize = clampSize(n)
    localStorage.setItem(CARD_SIZE_KEY, String(cardSize))
    set({ cardSize })
  },
  drafts: {},
  setDraft: (id, text) => set((s) => ({ drafts: { ...s.drafts, [id]: text } })),
  appendDraft: (id, text) => set((s) => ({ drafts: { ...s.drafts, [id]: (s.drafts[id] ?? '') + text } })),
  dragOverId: null,
  setDragOverId: (id) => set((s) => (s.dragOverId === id ? s : { dragOverId: id })),
  groupFilter: null,
  setGroupFilter: (cwd) => set({ groupFilter: cwd }),
  stateFilter: null,
  setStateFilter: (state) => set({ stateFilter: state })
}))

// hydrate once (including persisted drafts — typed text survives app restarts)
// and follow main-process state pushes (which never touch the local drafts map)
void window.api.getState().then((s) =>
  useApp.setState({
    ...s,
    drafts: Object.fromEntries(s.sessions.filter((x) => x.draft).map((x) => [x.id, x.draft!]))
  })
)
window.api.onStateChanged((s) => useApp.setState(s))

export const accountName = (accounts: Account[], dir: string): string =>
  accounts.find((a) => a.configDir === dir)?.name ?? dir

export const sortedSessions = (sessions: SessionView[]): SessionView[] =>
  [...sessions].sort((a, b) => a.order - b.order)
