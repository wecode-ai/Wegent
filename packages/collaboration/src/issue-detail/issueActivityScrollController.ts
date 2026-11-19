import type { ProjectChatMessage } from '@wegent/chat-core'

export interface IssueActivityScrollOptions {
  messages: ProjectChatMessage[]
  loading: boolean
  issueId?: string
  readSequence?: number
  unread?: boolean
  unreadRevision?: number
  readRequestKey?: string | null
  visibilityRevision?: string | number | null
  onReadSequence?(sequence: number): Promise<void> | void
  linear?: boolean
  compact?: boolean
  cardTestIdPrefix: string
}

/** The activity list DOM owns its read cursor, initial landing and explicit reply follow. */
export function createIssueActivityScrollController() {
  let node: HTMLDivElement | null = null
  let input: IssueActivityScrollOptions | undefined
  let followCard: string | null = null
  let initializedIssue: string | null = null
  let frame = 0
  let followRequested = false
  let initializeRequested = false
  let readState: VisibleReadState = { sequence: 0, pending: new Set() }
  const scroller = () => resolveTaskCommentScrollContainer(node, input?.linear ?? true)
  const revealCardBottom = (cardId: string, behavior: ScrollBehavior = 'auto') => {
    const card = node?.querySelector<HTMLElement>(
      `[data-testid="${input?.cardTestIdPrefix}${cardId}"]`
    )
    const viewport = scroller()
    if (!card || !viewport) return
    const bounds = viewport.getBoundingClientRect()
    const rect = card.getBoundingClientRect()
    if (rect.bottom > bounds.bottom)
      viewport.scrollTo({
        top: viewport.scrollTop + rect.bottom - bounds.bottom + 12,
        behavior,
      })
  }
  const scrollTaskCommentsToBottom = (behavior: ScrollBehavior = 'auto') => {
    const viewport = scroller()
    if (!viewport) return
    if (typeof viewport.scrollTo === 'function')
      viewport.scrollTo({ top: viewport.scrollHeight, behavior })
    else viewport.scrollTop = viewport.scrollHeight
  }
  const followSubmittedCard = () => {
    if (!input || !followCard) return
    revealCardBottom(followCard)
    const rootId = followCard
    const root = input.messages.find(message => message.messageId === rootId)
    if (!root) {
      followCard = null
      return
    }
    const lastRun = [root, ...input.messages.filter(message => message.rootMessageId === rootId)]
      .filter(message => message.sender.type === 'agent')
      .at(-1)
    if (
      lastRun &&
      ['completed', 'failed', 'interrupted', 'stalled', 'cancelled', 'canceled'].includes(
        lastRun.status
      )
    )
      followCard = null
  }
  const schedule = (initialize: boolean, follow: boolean) => {
    initializeRequested ||= initialize
    followRequested ||= follow
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      const viewport = scroller()
      if (!node || !input || !viewport) return
      const initialize = initializeRequested
      const follow = followRequested
      initializeRequested = false
      followRequested = false
      if (initialize && input.issueId && !input.loading && initializedIssue !== input.issueId) {
        const activities = Array.from(
          viewport.querySelectorAll<HTMLElement>(
            '[data-activity-sequence], [data-activity-collapsed-first-sequence]'
          )
        )
        if (activities.length) {
          initializedIssue = input.issueId
          const firstUnread = activities.find(element =>
            element.dataset.activityCollapsedFirstSequence !== undefined
              ? Number(element.dataset.activityCollapsedLastSequence) > readState.sequence
              : activitySequence(element) > readState.sequence
          )
          if (firstUnread)
            viewport.scrollTop +=
              firstUnread.getBoundingClientRect().top - viewport.getBoundingClientRect().top
          else scrollTaskCommentsToBottom()
        }
      }
      if (!input.loading)
        markVisibleActivitiesRead(
          viewport,
          readState,
          input.onReadSequence,
          input.unreadRevision,
          input.messages.length === 0
        )
      if (follow) followSubmittedCard()
    })
  }
  return {
    attach(list: HTMLDivElement, next: IssueActivityScrollOptions) {
      const sameIssue = readState.issueId === next.issueId
      if (!sameIssue) {
        followCard = null
        readState = {
          issueId: next.issueId,
          sequence: next.readSequence ?? 0,
          requestKey: next.readRequestKey,
          pending: new Set(),
        }
      } else if (readState.requestKey !== next.readRequestKey) {
        readState = {
          ...readState,
          requestKey: next.readRequestKey,
          revision: undefined,
          pending: new Set(),
        }
      }
      node = list
      input = next
      if (!next.loading && readState.baseline === undefined)
        readState.baseline = next.messages.reduce(
          (latest, message) => Math.max(latest, message.sequenceNumber),
          0
        )
      const sequence =
        (next.readSequence ?? 0) > 0 || (next.unread ?? true)
          ? (next.readSequence ?? 0)
          : (readState.baseline ?? 0)
      readState.sequence = Math.max(readState.sequence, sequence)
      schedule(true, true)
      return () => {
        if (node !== list || input !== next) return
        node = null
        cancelAnimationFrame(frame)
        frame = 0
        initializeRequested = false
        followRequested = false
      }
    },
    onScroll(event: Event) {
      const viewport = scroller()
      if (!viewport || event.target !== viewport || !input) return
      if (followCard) {
        const card = node?.querySelector<HTMLElement>(
          `[data-testid="${input.cardTestIdPrefix}${followCard}"]`
        )
        if (
          !card ||
          card.getBoundingClientRect().bottom > viewport.getBoundingClientRect().bottom + 24
        )
          followCard = null
      }
      schedule(false, false)
    },
    followCard(rootId: string) {
      followCard = rootId
    },
    revealCardBottom,
    scrollTaskCommentsToBottom,
  }
}

type IssueActivityListRef = ((node: HTMLDivElement | null) => void | (() => void)) & {
  current: HTMLDivElement | null
}

export function createIssueActivityListRef(
  owner: ReturnType<typeof createIssueActivityScrollController>,
  input: IssueActivityScrollOptions
) {
  // The callback is the native list binding; current also supports existing viewport readers.
  const ref: IssueActivityListRef = Object.assign(
    (node: HTMLDivElement | null) => {
      ref.current = node
      if (!node) return
      const detach = owner.attach(node, input)
      return () => {
        ref.current = null
        detach()
      }
    },
    { current: null as HTMLDivElement | null }
  )
  return ref
}

function activityElements(scroller: HTMLElement): HTMLElement[] {
  return Array.from(scroller.querySelectorAll<HTMLElement>('[data-activity-sequence]'))
}

function activitySequence(element: HTMLElement): number {
  const value = Number(element.dataset.activitySequence)
  return Number.isFinite(value) ? value : 0
}

interface VisibleReadState {
  issueId?: string
  baseline?: number
  sequence: number
  revision?: number
  requestKey?: string | null
  pending: Set<string>
}

function markVisibleActivitiesRead(
  scroller: HTMLElement,
  state: VisibleReadState,
  onReadSequence?: (sequence: number) => Promise<void> | void,
  unreadRevision?: number,
  emptyDiscussion = false
): void {
  if (!onReadSequence) return
  const viewport = scroller.getBoundingClientRect()
  let visible = false
  const sequence = activityElements(scroller).reduce((latest, element) => {
    const rect = element.getBoundingClientRect()
    if (rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom) {
      visible = true
      return Math.max(latest, activitySequence(element))
    }
    return latest
  }, 0)
  // A content acknowledgement also consumes notifications. Keep it pending while
  // unread messages remain hidden in a folded middle, even if the tail is visible.
  for (const element of scroller.querySelectorAll<HTMLElement>(
    '[data-activity-collapsed-first-sequence]'
  )) {
    const first = Number(element.dataset.activityCollapsedFirstSequence)
    const last = Number(element.dataset.activityCollapsedLastSequence)
    if (first > 0 && last > state.sequence) return
  }
  const unreadContent = unreadRevision !== undefined && unreadRevision > (state.revision ?? -1)
  if (
    sequence <= state.sequence &&
    !(unreadContent && (visible || (emptyDiscussion && viewport.height > 0)))
  )
    return
  const key = `${sequence}:${unreadRevision ?? ''}`
  if (state.pending.has(key)) return
  state.pending.add(key)
  void (async () => {
    try {
      await onReadSequence(sequence)
      state.sequence = Math.max(state.sequence, sequence)
      if (unreadRevision !== undefined) {
        state.revision = Math.max(state.revision ?? 0, unreadRevision)
      }
    } catch {
      // The host reports the failure. Keep the cursor retryable on visibility.
    } finally {
      state.pending.delete(key)
    }
  })()
}

export function findTaskCommentScrollContainer(element: HTMLElement | null): HTMLElement | null {
  if (!element) return null
  let current: HTMLElement | null = element
  while (current) {
    const overflowY = window.getComputedStyle(current).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') {
      return current
    }
    current = current.parentElement
  }
  return null
}

function resolveTaskCommentScrollContainer(
  element: HTMLElement | null,
  linear: boolean
): HTMLElement | null {
  return linear ? element : findTaskCommentScrollContainer(element)
}
