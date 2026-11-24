import type { RefObject } from 'react'
import type {
  MessageTurnNavigationProps,
  MessageTurnMarker,
  MeasuredScrollGeometry,
  UserTurn,
} from './turnNavigationTypes'
import {
  getMessageAnchorById,
  getTurnVisibilityBounds,
  equalStringArrays,
} from './turnNavigationUtils'
import {
  getScrollViewportBounds,
  getContentPositionForViewportY,
} from './conversationViewportScroll'

/** Anchors, visible markers and pending loads share one committed conversation viewport. */
export function createTurnNavigationGeometrySource() {
  let scrollRef: MessageTurnNavigationProps['scrollRef'] = { current: null }
  let contentRef: MessageTurnNavigationProps['contentRef'] = { current: null }
  let messages: RefObject<MessageTurnNavigationProps['messages']> = { current: [] }
  let turns: RefObject<UserTurn[]> = { current: [] }
  let snapshot: { markers: MessageTurnMarker[]; activeMarkerIds: string[] } = {
    markers: [],
    activeMarkerIds: [],
  }
  let loadOwner: object | null = null
  let ownerScroller: HTMLElement | null = null
  let ownerContent: HTMLElement | null = null
  let detachedOwner: object | null = null
  let onLoadOwnerInvalidated: ((owner: object) => void) | undefined
  let measured: MeasuredScrollGeometry | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let detach: (() => void) | undefined
  let observedScroller: HTMLElement | null = null
  let observedContent: HTMLElement | null = null
  const listeners = new Set<() => void>()
  const publish = () => listeners.forEach(listener => listener())
  const updateActiveMarkers = (markers: MessageTurnMarker[]) => {
    const scroller = scrollRef.current
    const viewport = scroller ? getScrollViewportBounds(scroller) : null
    const ids = viewport
      ? markers
          .filter(
            marker =>
              marker.visibleTop !== null &&
              marker.visibleBottom !== null &&
              marker.visibleBottom > viewport.startPx &&
              marker.visibleTop < viewport.endPx
          )
          .map(marker => marker.id)
      : []
    if (equalStringArrays(snapshot.activeMarkerIds, ids)) return
    snapshot = { ...snapshot, activeMarkerIds: ids }
  }
  const calculate = (reason: string) => {
    void reason
    const scroller = scrollRef.current
    const content = contentRef.current
    const userTurns = turns.current
    if (!scroller || !content || userTurns.length < 2) {
      snapshot = { markers: [], activeMarkerIds: [] }
      measured = null
      publish()
      return
    }

    const anchorByMessageId = getMessageAnchorById(content)
    const visibilityByTurnId = getTurnVisibilityBounds(
      userTurns,
      messages.current,
      anchorByMessageId,
      scroller
    )
    const nextMarkers = userTurns.map(turn => {
      const anchor = anchorByMessageId.get(turn.id)
      const visibleBounds = visibilityByTurnId.get(turn.id)
      if (!anchor) {
        return {
          ...turn,
          loaded: false,
          targetTop: null,
          visibleTop: visibleBounds?.top ?? null,
          visibleBottom: visibleBounds?.bottom ?? null,
        }
      }

      const anchorRect = anchor.getBoundingClientRect()
      const targetTop = getContentPositionForViewportY(scroller, anchorRect.top)
      return {
        ...turn,
        loaded: true,
        targetTop,
        visibleTop: visibleBounds?.top ?? targetTop,
        visibleBottom:
          visibleBounds?.bottom ?? getContentPositionForViewportY(scroller, anchorRect.bottom),
      }
    })

    measured = {
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
    }
    snapshot = { ...snapshot, markers: nextMarkers }
    updateActiveMarkers(nextMarkers)
    publish()
  }
  const schedule = (reason: string) => {
    if (timer !== undefined || !listeners.size) return
    timer = setTimeout(() => {
      timer = undefined
      calculate(reason)
    }, 0)
  }
  const observe = () => {
    const scroller = scrollRef.current
    const content = contentRef.current
    if (observedScroller === scroller && observedContent === content) return false
    if (loadOwner && (ownerScroller !== scroller || ownerContent !== content))
      invalidateOwner(loadOwner)
    detach?.()
    observedScroller = scroller
    observedContent = content
    if (!scroller || !content) {
      detach = undefined
      return true
    }
    const mutation = new MutationObserver(() => viewportChanged('mutation'))
    mutation.observe(content, {
      attributes: true,
      attributeFilter: ['style'],
      childList: true,
      subtree: true,
    })
    const resize =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => viewportChanged('resize-observer'))
    resize?.observe(content)
    resize?.observe(scroller)
    detach = () => {
      mutation.disconnect()
      resize?.disconnect()
    }
    return true
  }
  const invalidateOwner = (owner: object) => {
    onLoadOwnerInvalidated?.(owner)
    if (loadOwner === owner) loadOwner = null
  }
  const viewportChanged = (reason: string) => {
    if (!listeners.size) return
    observe()
    schedule(reason)
  }
  const bindInputs = (
    nextScroll: typeof scrollRef,
    nextContent: typeof contentRef,
    nextMessages: typeof messages,
    nextTurns: typeof turns
  ) => {
    scrollRef = nextScroll
    contentRef = nextContent
    messages = nextMessages
    turns = nextTurns
  }
  return {
    getSnapshot: () => snapshot,
    getLoadOwner: () => (listeners.size ? loadOwner : null),
    isLoadOwnerCurrent(owner: object) {
      return (
        listeners.size > 0 &&
        loadOwner === owner &&
        ownerScroller === scrollRef.current &&
        ownerContent === contentRef.current
      )
    },
    setLoadOwner(
      value: object | null,
      scroller?: HTMLElement | null,
      content?: HTMLElement | null
    ) {
      loadOwner = value
      ownerScroller = scroller ?? scrollRef.current
      ownerContent = content ?? contentRef.current
    },
    calculate,
    schedule,
    viewportChanged,
    handleScroll() {
      observe()
      const scroller = scrollRef.current
      if (
        scroller &&
        measured &&
        (scroller.scrollHeight !== measured.scrollHeight ||
          scroller.clientHeight !== measured.clientHeight)
      ) {
        schedule('scroll-layout-changed')
        return
      }
      const previous = snapshot
      updateActiveMarkers(snapshot.markers)
      if (snapshot !== previous) publish()
    },
    subscribe(
      listener: () => void,
      inputs: {
        scroll: typeof scrollRef
        content: typeof contentRef
        messages: typeof messages
        turns: typeof turns
        onLoadOwnerInvalidated(owner: object): void
      }
    ) {
      bindInputs(inputs.scroll, inputs.content, inputs.messages, inputs.turns)
      onLoadOwnerInvalidated = inputs.onLoadOwnerInvalidated
      listeners.add(listener)
      if (detachedOwner && detachedOwner === loadOwner) invalidateOwner(detachedOwner)
      detachedOwner = null
      if (observe()) calculate('subscribe')
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          detachedOwner = loadOwner
          clearTimeout(timer)
          timer = undefined
          detach?.()
          detach = undefined
          observedScroller = null
          observedContent = null
        })
      }
    },
  }
}
