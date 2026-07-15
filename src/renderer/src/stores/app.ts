import { create } from 'zustand'
import type { Account } from '@shared/types'
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
}

export const useApp = create<AppStore>((set) => ({
  accounts: [],
  sessions: [],
  recentLaunchArgs: [],
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
  setDragOverId: (id) => set((s) => (s.dragOverId === id ? s : { dragOverId: id }))
}))

// hydrate once and follow main-process state pushes
void window.api.getState().then((s) => useApp.setState(s))
window.api.onStateChanged((s) => useApp.setState(s))

export const accountName = (accounts: Account[], dir: string): string =>
  accounts.find((a) => a.configDir === dir)?.name ?? dir

export const sortedSessions = (sessions: SessionView[]): SessionView[] =>
  [...sessions].sort((a, b) => a.order - b.order)
