interface StoredQuickStartState {
  started: boolean
  detailsOpened: boolean
  collapsed: boolean
  dismissed: boolean
  completed: boolean
}

export interface BoardQuickStartProgress {
  hasCreatedItem: boolean
  hasAdvancedItem: boolean
  detailOpened: boolean
}

interface QuickStartSnapshot {
  state: StoredQuickStartState
  completionUntil?: number
}

const INITIAL_STATE: StoredQuickStartState = {
  started: false,
  detailsOpened: false,
  collapsed: false,
  dismissed: false,
  completed: false,
}

function readState(storageKey: string): StoredQuickStartState | null {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredQuickStartState>
    return {
      started: parsed.started === true,
      detailsOpened: parsed.detailsOpened === true,
      collapsed: parsed.collapsed === true,
      dismissed: parsed.dismissed === true,
      completed: parsed.completed === true,
    }
  } catch {
    return null
  }
}

/** Persisted guide progress; the completion announcement belongs to this viewing session. */
export class BoardQuickStartSession {
  private snapshot: QuickStartSnapshot
  private initialized: boolean
  private listeners = new Set<() => void>()

  private readonly storageKey: string

  constructor(storageKey: string) {
    this.storageKey = storageKey
    const stored = readState(storageKey)
    this.initialized = stored !== null
    this.snapshot = { state: stored ?? INITIAL_STATE }
  }

  getSnapshot = (): QuickStartSnapshot => this.snapshot

  observe(listener: () => void, progress: BoardQuickStartProgress): () => void {
    this.listeners.add(listener)
    this.advance(progress)
    return () => this.listeners.delete(listener)
  }

  update(patch: Pick<Partial<StoredQuickStartState>, 'collapsed' | 'dismissed'>): void {
    this.publish({ ...this.snapshot.state, ...patch })
  }

  private advance({ hasCreatedItem, hasAdvancedItem, detailOpened }: BoardQuickStartProgress) {
    const previous = this.snapshot.state
    const started = previous.started || (!this.initialized && !hasCreatedItem)
    this.initialized = true
    const detailsOpened = previous.detailsOpened || (started && detailOpened)
    const completed =
      previous.completed || (started && hasCreatedItem && hasAdvancedItem && detailsOpened)
    if (
      previous.started === started &&
      previous.detailsOpened === detailsOpened &&
      previous.completed === completed
    )
      return
    this.publish(
      { ...previous, started, detailsOpened, completed },
      completed && !previous.completed ? Date.now() + 5000 : this.snapshot.completionUntil
    )
  }

  private publish(state: StoredQuickStartState, completionUntil = this.snapshot.completionUntil) {
    this.snapshot = { state, completionUntil }
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(state))
    } catch {
      // Guide persistence must never block the board when local storage is unavailable.
    }
    this.listeners.forEach(listener => listener())
  }
}
