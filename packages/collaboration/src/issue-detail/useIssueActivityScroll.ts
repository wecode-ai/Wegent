import { useCallback, useEffect, useRef } from 'react'
import type { ProjectChatMessage } from '@wegent/chat-core'

/** Shared PC scroll policy: follow the submitted card, never unrelated incoming activity. */
export function useIssueActivityScroll({
  messages: threadMessages,
  loading,
  issueId,
  readSequence: storedReadSequence = 0,
  unread = true,
  unreadRevision,
  readRequestKey,
  onReadSequence,
  linear = true,
  compact = true,
  cardTestIdPrefix,
}: {
  messages: ProjectChatMessage[]
  loading: boolean
  issueId?: string
  readSequence?: number
  unread?: boolean
  unreadRevision?: number
  readRequestKey?: string | null
  onReadSequence?(sequence: number): Promise<void> | void
  linear?: boolean
  compact?: boolean
  cardTestIdPrefix: string
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const followCardRef = useRef<string | null>(null)
  const initializedIssueRef = useRef<string | null>(null)
  const readStateRef = useRef<VisibleReadState>({
    issueId,
    sequence: storedReadSequence,
    requestKey: readRequestKey,
    pending: new Set(),
  })
  useEffect(() => {
    if (readStateRef.current.issueId !== issueId) {
      readStateRef.current = {
        issueId,
        sequence: storedReadSequence,
        requestKey: readRequestKey,
        pending: new Set(),
      }
    } else if (readStateRef.current.requestKey !== readRequestKey) {
      // A fresh navigation consumes later notifications without resetting scroll progress.
      readStateRef.current = {
        ...readStateRef.current,
        requestKey: readRequestKey,
        revision: undefined,
        pending: new Set(),
      }
    }
    const state = readStateRef.current
    if (!loading && state.baseline === undefined) {
      state.baseline = threadMessages.reduce(
        (latest, message) => Math.max(latest, message.sequenceNumber),
        0
      )
    }
    const sequence = storedReadSequence > 0 || unread ? storedReadSequence : (state.baseline ?? 0)
    state.sequence = Math.max(state.sequence, sequence)
  }, [issueId, loading, storedReadSequence, threadMessages, unread, readRequestKey])
  const markVisibleRead = useCallback(
    (scroller: HTMLElement) => {
      const state = readStateRef.current
      if (state.issueId !== issueId) return
      markVisibleActivitiesRead(
        scroller,
        state,
        onReadSequence,
        unreadRevision,
        threadMessages.length === 0
      )
    },
    [issueId, onReadSequence, threadMessages.length, unreadRevision, readRequestKey]
  )
  const scrollTaskCommentsToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      const scroller = resolveTaskCommentScrollContainer(listRef.current, linear)
      if (scroller) {
        if (typeof scroller.scrollTo === 'function') {
          scroller.scrollTo({ top: scroller.scrollHeight, behavior })
        } else {
          scroller.scrollTop = scroller.scrollHeight
        }
      }
    },
    [linear]
  )

  // Card replies grow inside their own card; keep the card's bottom visible
  // (where the new reply and the streaming AI response appear) instead of
  // jumping to the end of the whole comment list.
  const revealCardBottom = useCallback(
    (cardId: string, behavior: ScrollBehavior = 'auto') => {
      const card = listRef.current?.querySelector<HTMLElement>(
        `[data-testid="${cardTestIdPrefix}${cardId}"]`
      )
      const scroller = resolveTaskCommentScrollContainer(listRef.current, linear)
      if (!card || !scroller) return
      const scrollerRect = scroller.getBoundingClientRect()
      const cardRect = card.getBoundingClientRect()
      if (cardRect.bottom > scrollerRect.bottom) {
        scroller.scrollTo({
          top: scroller.scrollTop + cardRect.bottom - scrollerRect.bottom + 12,
          behavior,
        })
      }
    },
    [linear, cardTestIdPrefix]
  )

  useEffect(() => {
    const scroller = resolveTaskCommentScrollContainer(listRef.current, linear)
    if (!scroller) return
    const updateFollowState = () => {
      if (followCardRef.current) {
        const card = listRef.current?.querySelector<HTMLElement>(
          `[data-testid="${cardTestIdPrefix}${followCardRef.current}"]`
        )
        if (!card) {
          followCardRef.current = null
          return
        }
        const cardBottom = card.getBoundingClientRect().bottom
        const scrollerBottom = scroller.getBoundingClientRect().bottom
        if (cardBottom > scrollerBottom + 24) followCardRef.current = null
        return
      }
    }
    scroller.addEventListener('scroll', updateFollowState, { passive: true })
    return () => scroller.removeEventListener('scroll', updateFollowState)
  }, [compact, linear, loading, threadMessages.length, cardTestIdPrefix])

  useEffect(() => {
    if (!issueId || loading || initializedIssueRef.current === issueId) return
    const frame = requestAnimationFrame(() => {
      const scroller = resolveTaskCommentScrollContainer(listRef.current, linear)
      if (!scroller) return
      const activities = activityElements(scroller)
      if (activities.length === 0) return
      initializedIssueRef.current = issueId
      const firstUnread = activities.find(
        element => activitySequence(element) > readStateRef.current.sequence
      )
      if (firstUnread) {
        const scrollerRect = scroller.getBoundingClientRect()
        const activityRect = firstUnread.getBoundingClientRect()
        scroller.scrollTop = scroller.scrollTop + activityRect.top - scrollerRect.top
      } else {
        scrollTaskCommentsToBottom()
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [issueId, linear, loading, scrollTaskCommentsToBottom, threadMessages.length])

  useEffect(() => {
    const scroller = resolveTaskCommentScrollContainer(listRef.current, linear)
    if (!scroller || !onReadSequence || loading) return
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => markVisibleRead(scroller))
    }
    // Empty discussions still contain the Issue content and creation record.
    // Re-check after incoming activity renders, without moving the reader.
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', update)
    }
  }, [linear, loading, markVisibleRead, onReadSequence, threadMessages])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (followCardRef.current) {
        revealCardBottom(followCardRef.current)
        const rootId = followCardRef.current
        const followedRoot = threadMessages.find(message => message.messageId === rootId)
        const followed = followedRoot
          ? {
              root: followedRoot,
              replies: threadMessages.filter(message => message.rootMessageId === rootId),
            }
          : null
        if (!followed) {
          followCardRef.current = null
          return
        }
        const lastRun = [followed.root, ...followed.replies]
          .filter(message => message.sender.type === 'agent')
          .at(-1)
        if (
          lastRun &&
          ['completed', 'failed', 'interrupted', 'stalled', 'cancelled', 'canceled'].includes(
            lastRun.status
          )
        ) {
          followCardRef.current = null
        }
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [compact, loading, revealCardBottom, threadMessages])

  return {
    listRef,
    followCard: (rootId: string) => {
      followCardRef.current = rootId
    },
    scrollTaskCommentsToBottom,
    revealCardBottom,
  }
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

function findTaskCommentScrollContainer(element: HTMLElement | null): HTMLElement | null {
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
