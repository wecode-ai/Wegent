import type { RefObject } from 'react'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import {
  getConversationScrollSnapshot,
  type ConversationScrollSnapshot,
} from './conversationViewportCache'
import {
  getDistanceFromBottom,
  isConversationScrollInput,
  setDistanceFromBottom,
} from './conversationViewportScroll'
import {
  BOTTOM_THRESHOLD,
  SCROLLED_TO_BOTTOM_THRESHOLD,
  type UserViewportAnchor,
  type RuntimeTranscriptGap,
} from './scrollableMessageTypes'
import {
  createScrollSnapshot,
  findLatestGuidanceMessageId,
  findLatestUserMessageId,
  restoreConversationAnchor,
  setConversationScrollSnapshot,
} from './conversationScrollGeometry'
import { createReaderViewportAnchor } from './readerViewportAnchor'
import type { ConversationVirtualizer } from './useConversationVirtualizer'
import { getMessageLayoutSignature } from './messagePretextLayout'
import { runtimeTranscriptGapKey } from './RuntimeTranscriptGapMarker'
import { recordConversationScrollDiagnostic } from './conversationDiagnostics'
import {
  CONVERSATION_SCROLL_WRITE_SOURCE,
  recordConversationScrollWrite,
} from './conversationScrollWrite'
import {
  requestSafeAnimationFrame,
  cancelSafeAnimationFrame,
  type SafeAnimationFrameHandle,
} from '../markdown/safeAnimationFrame'

export interface ConversationScrollInput {
  messages: WorkbenchMessage[]
  scrollRef: RefObject<HTMLDivElement | null>
  externalScrollInteractionRef?: RefObject<HTMLElement | null>
  loading?: boolean
  isWaitingForAssistant?: boolean
  autoScrollSuspended?: boolean
  initialScrollPosition?: 'restore' | 'latest'
  onLoadTranscriptGap?: (gap: RuntimeTranscriptGap) => Promise<void> | void
}
type ScrollConfiguration = Omit<
  ConversationScrollInput,
  'scrollRef' | 'externalScrollInteractionRef'
>
interface ScrollPorts {
  scrollRef: ConversationScrollInput['scrollRef']
  externalScrollInteractionRef: ConversationScrollInput['externalScrollInteractionRef']
  owner: { lease: symbol | null }
  contentRef: RefObject<HTMLDivElement | null>
  virtualizerRef: RefObject<ConversationVirtualizer | null>
}
type ViewportMode = 'follow' | 'read' | 'navigate' | 'drag'
interface ScrollSnapshot {
  mode: ViewportMode
  virtualAnchorToEnd: boolean
  showScrollButton: boolean
  turnNavigationLoading: boolean
  turnNavigationTargetMessageId: string | null
  loadingTranscriptGapKey: string | null
  viewport: HTMLDivElement | null
  interaction: HTMLElement | null
}

/** One actual transcript viewport owns follow intent, navigation, reader anchors and paging. */
export function createConversationScrollState(
  currentScrollKey: string | null,
  initialInput: ScrollConfiguration
) {
  let contentRef: ScrollPorts['contentRef'] = { current: null }
  let virtualizerRef: ScrollPorts['virtualizerRef'] = { current: null }
  let ownedVirtualizer: ConversationVirtualizer | null = null
  const readVirtualizer = () => {
    if (owned()) ownedVirtualizer = virtualizerRef.current
    return ownedVirtualizer
  }
  let messages: WorkbenchMessage[] = []
  let scrollRef: RefObject<HTMLDivElement | null> = { current: null }
  let externalScrollInteractionRef: RefObject<HTMLElement | null> | undefined
  let loading: boolean | undefined
  let autoScrollSuspended: boolean | undefined
  let initialScrollPosition: 'restore' | 'latest' | undefined
  let onLoadTranscriptGap: ConversationScrollInput['onLoadTranscriptGap']
  let streaming = false
  let input: ConversationScrollInput | null = null
  let contentLease: symbol | null = null
  let contentOwner: ScrollPorts['owner'] | null = null
  let hasContentPort = false
  let stopped = false
  const listeners = new Set<() => void>()
  const owned = () =>
    !stopped &&
    (hasContentPort
      ? contentLease !== null && contentOwner?.lease === contentLease
      : listeners.size > 0)
  let state: ScrollSnapshot = {
    mode: 'follow',
    virtualAnchorToEnd:
      !initialInput.autoScrollSuspended &&
      !initialInput.messages.some(message => message.status === 'streaming'),
    showScrollButton: false,
    turnNavigationLoading: false,
    turnNavigationTargetMessageId: null,
    loadingTranscriptGapKey: null,
    viewport: null,
    interaction: null,
  }
  function publish(change: Partial<ScrollSnapshot> = {}) {
    const next = { ...state, ...change }
    // A streaming viewport already disables TanStack follow during native animation.
    next.virtualAnchorToEnd =
      next.mode === 'follow' && !streaming && !autoScrollSuspended && nativeFollow === null
    if (
      Object.keys(next).every(
        key => next[key as keyof ScrollSnapshot] === state[key as keyof ScrollSnapshot]
      )
    )
      return
    state = next
    for (const listener of listeners) listener()
  }
  const readerState = {
    anchor: null as UserViewportAnchor | null,
    selfScrollOffset: 0,
    lastMeasuredLayout: null as string | null,
    lastScrollPosition: null as number | null,
  }
  const reader = createReaderViewportAnchor(
    () => scrollRef.current,
    () => contentRef.current,
    readerState
  )
  const { captureUserViewportAnchor, restoreReaderPositionFromLayout } = reader
  let historyLayoutSamples = 0
  const traceHistoryLayout = (phase: 'prepare' | 'captured' | 'layout') => {
    if (!historyLayoutSamples) return
    historyLayoutSamples--
    const viewport = scrollRef.current
    const anchor = readerState.anchor
    const item = anchor?.element.closest<HTMLElement>(
      '[data-runtime-item-id], [data-processing-block-id]'
    )
    // Use the host's persisted diagnostic channel; generic renderer logs are not retained.
    console.debug(
      '[Wework] Runtime task create diagnostic',
      JSON.stringify({
        stage: 'history-prepend-layout',
        timestamp: new Date().toISOString(),
        phase,
        mode: state.mode,
        owned: owned(),
        anchorItemId: anchor?.itemId ?? null,
        anchorConnected: anchor?.element.isConnected ?? false,
        anchorOffset: anchor?.offsetFromScrollerTop ?? null,
        anchorTextOffset: anchor?.textOffset ?? null,
        anchorScrollTop: anchor?.scrollTopPx ?? null,
        selfScrollOffset: readerState.selfScrollOffset,
        lastScrollPosition: readerState.lastScrollPosition,
        itemTop:
          item && viewport
            ? item.getBoundingClientRect().top - viewport.getBoundingClientRect().top
            : null,
        scrollTop: viewport?.scrollTop ?? null,
        scrollHeight: viewport?.scrollHeight ?? null,
        clientHeight: viewport?.clientHeight ?? null,
      })
    )
  }
  let lastSnapshot: { key: string | null; snapshot: ConversationScrollSnapshot } | null = null
  let restoring: ConversationScrollSnapshot | null = null
  let restoreNeedsDistance = false
  let inputActive = false
  let inputDirection: 'backward' | 'forward' | null = null
  let nativeFollow: { viewport: HTMLDivElement; end: number } | null = null
  let layoutFrame: SafeAnimationFrameHandle | null = null
  let followBehavior: 'auto' | 'smooth' = 'auto'
  let initializedKey: string | null | undefined
  let command = false
  const clearAnchor = () => {
    readerState.anchor = null
    readerState.selfScrollOffset = 0
    readerState.lastMeasuredLayout = null
  }
  const cancelNativeFollow = () => {
    const active = nativeFollow
    nativeFollow = null
    if (!active || !owned()) return
    const { viewport } = active
    viewport.scrollTo({ top: viewport.scrollTop, behavior: 'instant' })
  }
  const cancelMotion = () => {
    if (layoutFrame) cancelSafeAnimationFrame(layoutFrame)
    layoutFrame = null
    cancelNativeFollow()
    publish()
    readVirtualizer()?.cancelScroll()
  }
  const changeMode = (next: ViewportMode) => {
    publish({ mode: next })
    // Disable both append follow and resize-at-end before the next React commit.
    const engine = readVirtualizer()
    if (engine && next !== 'follow') {
      engine.cancelScroll()
      engine.shouldAdjustScrollPositionOnItemSizeChange = next === 'read' ? undefined : () => false
      engine.setOptions({
        ...engine.options,
        anchorTo: next === 'navigate' || next === 'drag' ? 'start' : 'end',
        followOnAppend: false,
        scrollEndThreshold: -1,
      })
    }
  }
  const onVirtualScrollAdjustment = (delta: number) => {
    if (!owned()) return
    if (!command && readerState.anchor) readerState.selfScrollOffset += delta
  }
  const writeOffset = (top: number) => {
    if (!owned()) return
    const viewport = scrollRef.current
    if (!viewport) return
    const currentOffset = viewport.scrollTop
    if (top === currentOffset) {
      readerState.lastScrollPosition = currentOffset
      return
    }
    command = true
    try {
      recordConversationScrollWrite(
        viewport,
        CONVERSATION_SCROLL_WRITE_SOURCE.controllerBottom,
        top,
        () => {
          if (typeof viewport.scrollTo === 'function') viewport.scrollTo({ top, behavior: 'auto' })
          else viewport.scrollTop = top
        }
      )
    } finally {
      command = false
    }
    readerState.lastScrollPosition = viewport.scrollTop
  }
  const publishScrollButton = (distanceFromBottom: number) => {
    const showScrollButton = distanceFromBottom > BOTTOM_THRESHOLD
    if (state.showScrollButton !== showScrollButton) publish({ showScrollButton })
  }
  const save = (measuredDistanceFromBottomPx?: number) => {
    if (!owned()) return
    const viewport = scrollRef.current
    if (!viewport || messages.length === 0 || autoScrollSuspended) return
    const snapshot: ConversationScrollSnapshot =
      state.mode === 'follow'
        ? { pinnedToBottom: true, distanceFromBottomPx: 0 }
        : state.mode === 'drag'
          ? {
              pinnedToBottom: false,
              distanceFromBottomPx: getDistanceFromBottom(viewport),
            }
          : createScrollSnapshot(viewport)
    if (state.mode === 'read' || state.mode === 'drag') snapshot.pinnedToBottom = false
    if (state.mode === 'follow') {
      snapshot.pinnedToBottom = true
      snapshot.distanceFromBottomPx = 0
      delete snapshot.anchor
    }
    lastSnapshot = { key: currentScrollKey, snapshot }
    if (currentScrollKey) setConversationScrollSnapshot(currentScrollKey, snapshot)
    publishScrollButton(measuredDistanceFromBottomPx ?? getDistanceFromBottom(viewport))
  }
  const followEnd = (viewport: HTMLDivElement) => {
    const nativeHeight = viewport.scrollHeight
    const engine = readVirtualizer()
    // A settled tail in the visible range owns the DOM bottom. Its Markdown
    // can grow during this commit, before the virtualizer publishes row sizes.
    const settledTailVisible =
      engine && !streaming && engine.range?.endIndex === engine.options.count - 1
    const height =
      engine && !settledTailVisible
        ? Math.min(nativeHeight, Math.round(engine.getTotalSize() + engine.options.scrollMargin))
        : nativeHeight
    return Math.max(0, height - viewport.clientHeight)
  }
  const follow = (smooth = false) => {
    if (!owned()) return
    if (
      state.mode !== 'follow' ||
      autoScrollSuspended ||
      state.turnNavigationLoading ||
      state.turnNavigationTargetMessageId
    )
      return
    const viewport = scrollRef.current
    if (!viewport) return
    const end = followEnd(viewport)
    const distanceFromBottom = Math.max(0, end - viewport.scrollTop)
    if (distanceFromBottom < 1) {
      cancelMotion()
      save(distanceFromBottom)
      return
    }
    const animate = nativeFollow !== null || smooth || followBehavior === 'smooth'
    if (
      !animate ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ||
      typeof viewport.scrollTo !== 'function'
    ) {
      cancelMotion()
      writeOffset(end)
      save(Math.max(0, end - (readerState.lastScrollPosition ?? viewport.scrollTop)))
      return
    }
    if (nativeFollow?.viewport === viewport && nativeFollow.end === end) return
    nativeFollow = { viewport, end }
    const engine = readVirtualizer()
    if (engine) {
      engine.cancelScroll()
      engine.setOptions({
        ...engine.options,
        followOnAppend: false,
        scrollEndThreshold: -1,
      })
    }
    publish()
    viewport.scrollTo({ top: end, behavior: 'smooth' })
    if (state.showScrollButton) publish({ showScrollButton: false })
  }
  const handleContentLayoutChange = () => {
    if (!owned()) return
    if (initializedKey !== currentScrollKey) return
    if (autoScrollSuspended || state.mode === 'navigate' || state.mode === 'drag') return
    const viewport = scrollRef.current
    if (!viewport) return
    const snapshot = restoring
    if (snapshot && !snapshot.pinnedToBottom) {
      if (restoreNeedsDistance || !snapshot.anchor) {
        setDistanceFromBottom(viewport, snapshot.distanceFromBottomPx, 'auto')
        restoreNeedsDistance = false
      }
      restoreConversationAnchor(viewport, snapshot)
    } else if (state.mode === 'read') restoreReaderPositionFromLayout()
    else follow()
    if (state.mode === 'read') publishScrollButton(getDistanceFromBottom(viewport))
    traceHistoryLayout('layout')
  }
  const handleVirtualLayoutChange = () => {
    if (!owned()) return
    if (autoScrollSuspended) return
    if (state.mode !== 'follow' || !streaming || followBehavior !== 'smooth') {
      handleContentLayoutChange()
      return
    }
    if (layoutFrame) return
    layoutFrame = requestSafeAnimationFrame(() => {
      layoutFrame = null
      handleContentLayoutChange()
    })
  }
  let layoutObserver: ResizeObserver | null = null
  let observedViewport: HTMLDivElement | null = null
  let observedContent: HTMLDivElement | null = null
  function stopObservingLayout() {
    layoutObserver?.disconnect()
    layoutObserver = null
    observedViewport = null
    observedContent = null
  }
  function observeLayout() {
    const viewport = scrollRef.current
    const content = contentRef.current
    if (viewport === observedViewport && content === observedContent) return
    stopObservingLayout()
    if (!viewport || !content || typeof ResizeObserver === 'undefined') return
    // Scroll handling only needs size changes. Reading and publishing both
    // bounds on every scroll step also rerenders the entire transcript.
    layoutObserver = new ResizeObserver(handleVirtualLayoutChange)
    layoutObserver.observe(viewport)
    layoutObserver.observe(content)
    observedViewport = viewport
    observedContent = content
  }
  const preserveScrollPositionForNextLayout = () => {
    if (!owned()) return
    cancelMotion()
    if (state.mode === 'drag') return
    restoring = null
    changeMode('read')
    captureUserViewportAnchor()
  }
  const preserveUserMessagePosition = preserveScrollPositionForNextLayout
  const prepareForHistoryPrepend = () => {
    historyLayoutSamples = 8
    traceHistoryLayout('prepare')
    if (!owned()) return
    // Prefetching a short initial page must retain live following. A reader already
    // browsing history owns a semantic anchor, including growth inside one turn.
    if (state.mode === 'read') preserveScrollPositionForNextLayout()
    traceHistoryLayout('captured')
  }
  const finishNavigation = () => {
    if (!owned()) return
    if (state.turnNavigationLoading || state.turnNavigationTargetMessageId) return
    if (state.mode !== 'navigate') return
    const viewport = scrollRef.current
    if (!viewport) return
    restoring = null
    const nextMode =
      getDistanceFromBottom(viewport) <= SCROLLED_TO_BOTTOM_THRESHOLD ? 'follow' : 'read'
    changeMode(nextMode)
    clearAnchor()
    if (nextMode === 'read') captureUserViewportAnchor()
    save()
  }
  const handleTurnNavigationScrollTargetChange = (messageId: string | null) => {
    if (!owned()) return
    const wasNavigating = state.turnNavigationTargetMessageId !== null
    publish({ turnNavigationTargetMessageId: messageId })
    if (messageId) {
      cancelMotion()
      changeMode('navigate')
      clearAnchor()
      restoring = null
    } else if (wasNavigating) finishNavigation()
  }
  const handleTurnNavigationLoadStateChange = (loading: boolean) => {
    if (!owned()) return
    const wasLoading = state.turnNavigationLoading
    publish({ turnNavigationLoading: loading })
    if (loading) {
      cancelMotion()
      changeMode('navigate')
    } else if (wasLoading) finishNavigation()
  }

  let previousCommit: {
    key: string | null
    count: number
    user: string | null
    guidance: string | null
    loading: boolean
    messages: WorkbenchMessage[]
    suspended: boolean
  } | null = null

  function commit(next: ConversationScrollInput, refresh = false) {
    const previousInput = input
    const previousViewport = state.viewport
    const previousInteraction = state.interaction
    input = next
    ;({
      messages,
      scrollRef,
      externalScrollInteractionRef,
      loading,
      autoScrollSuspended,
      initialScrollPosition,
      onLoadTranscriptGap,
    } = next)
    streaming = messages.some(message => message.status === 'streaming')
    publish({
      viewport: scrollRef.current,
      interaction: externalScrollInteractionRef?.current ?? null,
    })
    if (!owned()) return
    observeLayout()
    if (previousViewport !== state.viewport) cancelMotion()
    const changed =
      !previousInput ||
      previousInput.messages !== next.messages ||
      previousInput.loading !== next.loading ||
      previousInput.isWaitingForAssistant !== next.isWaitingForAssistant ||
      previousInput.autoScrollSuspended !== next.autoScrollSuspended ||
      previousInput.initialScrollPosition !== next.initialScrollPosition
    if (changed) reconcile()
    else if (
      refresh ||
      previousViewport !== state.viewport ||
      previousInteraction !== state.interaction
    )
      handleContentLayoutChange()
  }
  function reconcile() {
    const previous = previousCommit
    const user = findLatestUserMessageId(messages)
    const guidance = findLatestGuidanceMessageId(messages)
    const changed = !previous || previous.key !== currentScrollKey
    const loaded = previous?.count === 0 && messages.length > 0
    const resumed = previous?.suspended && !autoScrollSuspended
    const previousTail = previous?.messages.at(-1)
    const previousTailIndex = messages.findIndex(message => message.id === previousTail?.id)
    const latestGuidance = messages.find(message => message.id === guidance)
    // Guidance can split and replace the tail message. In that case its creation
    // time distinguishes a new instruction from an older hydrated instruction.
    const newGuidance =
      guidance !== null &&
      guidance !== previous?.guidance &&
      (previousTailIndex >= 0
        ? messages.findIndex(message => message.id === guidance) > previousTailIndex
        : previousTail &&
          latestGuidance &&
          Date.parse(latestGuidance.createdAt) > Date.parse(previousTail.createdAt))
    const sent =
      !changed &&
      !loading &&
      !previous.loading &&
      // A paged Goal history can contain only assistant replies. Distinguish a
      // new request after its tail from an older user prompt prepended by paging.
      ((user !== null &&
        user !== previous.user &&
        (previous.user !== null ||
          (previousTailIndex >= 0 &&
            messages.findIndex(message => message.id === user) > previousTailIndex))) ||
        (previous.count === 0 && messages.at(-1)?.role === 'user') ||
        newGuidance)
    // Opening/hydrating history establishes a position; only new content in an
    // already-loaded conversation requests streaming motion. Keep that intent
    // through the ResizeObserver measurements caused by the same content commit.
    if (
      changed ||
      loaded ||
      sent ||
      resumed ||
      loading ||
      previous?.loading ||
      autoScrollSuspended
    ) {
      cancelMotion()
      followBehavior = sent && streaming ? 'smooth' : 'auto'
    } else if (!streaming) followBehavior = 'auto'
    else if (
      messages !== previous.messages &&
      messages.some(message => {
        if (message.status !== 'streaming') return false
        const before = previous.messages.find(candidate => candidate.id === message.id)
        return !before || getMessageLayoutSignature(message) !== getMessageLayoutSignature(before)
      })
    )
      followBehavior = 'smooth'
    previousCommit = {
      key: currentScrollKey,
      count: messages.length,
      user,
      guidance,
      loading: Boolean(loading),
      messages,
      suspended: Boolean(autoScrollSuspended),
    }
    if (changed) {
      clearAnchor()
      restoring = null
      inputActive = false
      publish({ turnNavigationTargetMessageId: null, turnNavigationLoading: false })
    }
    initializedKey = currentScrollKey
    if (
      (changed || loaded) &&
      messages.length > 0 &&
      !(loaded && !changed && state.mode === 'read')
    ) {
      const snapshot =
        initialScrollPosition === 'latest'
          ? undefined
          : currentScrollKey
            ? getConversationScrollSnapshot(currentScrollKey)
            : undefined
      restoring = snapshot && !snapshot.pinnedToBottom ? snapshot : null
      restoreNeedsDistance = restoring !== null
      changeMode(snapshot && !snapshot.pinnedToBottom ? 'read' : 'follow')
      const viewport = scrollRef.current
      if (viewport && snapshot && !snapshot.pinnedToBottom && !autoScrollSuspended) {
        setDistanceFromBottom(viewport, snapshot.distanceFromBottomPx, 'auto')
        restoreConversationAnchor(viewport, snapshot)
      }
    }
    if (sent) {
      clearAnchor()
      restoring = null
      changeMode('follow')
    }
    if (changed || loaded || sent || resumed) handleContentLayoutChange()
    else handleVirtualLayoutChange()
  }
  let pointerStepObserved = true
  const markInput = (event: Event) => {
    if (!owned()) return
    const viewport = scrollRef.current
    if (!viewport) return
    if (!isConversationScrollInput(event)) return
    const interaction = externalScrollInteractionRef?.current
    const scrollbarPointer =
      interaction?.contains(event.target as Node) && event instanceof PointerEvent
    if (event instanceof PointerEvent && !scrollbarPointer) return
    if (state.mode === 'read') restoreReaderPositionFromLayout()
    cancelMotion()
    restoring = null
    inputActive = true
    inputDirection =
      event instanceof WheelEvent && event.deltaY !== 0
        ? event.deltaY < 0
          ? 'backward'
          : 'forward'
        : event instanceof KeyboardEvent
          ? ['ArrowUp', 'PageUp', 'Home'].includes(event.key)
            ? 'backward'
            : 'forward'
          : null
    pointerStepObserved = false
    recordConversationScrollDiagnostic('scroll-input', viewport, {
      deltaY: event instanceof WheelEvent ? event.deltaY : null,
      paused: state.mode === 'read',
    })
    readerState.lastScrollPosition = viewport.scrollTop
    if (event instanceof KeyboardEvent && event.key === 'End') {
      // End selects follow intent before row measurements can change the range.
      inputActive = false
      clearAnchor()
      changeMode('follow')
      return
    }
    if (scrollbarPointer) {
      changeMode('drag')
      clearAnchor()
    } else {
      captureUserViewportAnchor()
      // Publish reader intent before row measurements can precede native scroll delivery.
      if (
        inputDirection === 'backward' ||
        getDistanceFromBottom(viewport) > SCROLLED_TO_BOTTOM_THRESHOLD
      )
        changeMode('read')
    }
  }
  const scroll = () => {
    if (!owned()) return
    const viewport = scrollRef.current
    if (!viewport) return
    if (autoScrollSuspended || state.mode === 'navigate') return
    if (state.mode === 'drag') {
      readerState.lastScrollPosition = viewport.scrollTop
      pointerStepObserved = true
      save()
      return
    }
    if (inputActive) {
      const previous = readerState.lastScrollPosition ?? viewport.scrollTop
      const upward =
        inputDirection === 'backward' ||
        (inputDirection === null && viewport.scrollTop < previous - 0.5)
      changeMode(
        !upward && getDistanceFromBottom(viewport) <= SCROLLED_TO_BOTTOM_THRESHOLD
          ? 'follow'
          : 'read'
      )
      readerState.lastScrollPosition = viewport.scrollTop
      restoreReaderPositionFromLayout()
      save()
      pointerStepObserved = true
    } else if (state.mode === 'read') handleContentLayoutChange()
    else if (nativeFollow === null) follow()
    else readerState.lastScrollPosition = viewport.scrollTop
  }
  const endInput = () => {
    if (!owned()) return
    const viewport = scrollRef.current
    if (!viewport) return
    if (state.mode === 'drag') return
    if (!inputActive && state.mode === 'follow' && nativeFollow?.viewport === viewport) {
      if (Math.abs(nativeFollow.end - viewport.scrollTop) > 1) return
      nativeFollow = null
      publish()
    }
    inputActive = false
    save()
  }
  const endDrag = () => {
    if (!owned()) return
    const viewport = scrollRef.current
    if (!viewport) return
    if (state.mode !== 'drag') return
    inputActive = false
    const nextMode =
      getDistanceFromBottom(viewport) <= SCROLLED_TO_BOTTOM_THRESHOLD ? 'follow' : 'read'
    changeMode(nextMode)
    clearAnchor()
    if (nextMode === 'read') captureUserViewportAnchor()
    save()
  }
  const drag = (event: PointerEvent) => {
    if (!owned()) return
    const viewport = scrollRef.current
    if (!viewport) return
    if (event.buttons === 1 && pointerStepObserved) markInput(event)
  }

  const handleScrollToBottom = () => {
    if (!owned()) return
    cancelMotion()
    clearAnchor()
    restoring = null
    inputActive = false
    changeMode('follow')
    save()
    follow(true)
  }

  let gapLoadOwner: object | null = null
  const autoLoadedTranscriptGapKeys = new Set<string>()
  const loadTranscriptGap = async (gap: RuntimeTranscriptGap, reason: 'visible' | 'click') => {
    if (!owned() || !onLoadTranscriptGap || state.loadingTranscriptGapKey) return
    const gapKey = runtimeTranscriptGapKey(gap)
    if (reason === 'visible') {
      if (autoLoadedTranscriptGapKeys.has(gapKey)) return
      autoLoadedTranscriptGapKeys.add(gapKey)
    }
    // Automatic gap hydration preserves the current viewport intent, just like history prefetch.
    if (reason === 'click' || state.mode === 'read') preserveScrollPositionForNextLayout()
    const owner = {}
    gapLoadOwner = owner
    publish({ loadingTranscriptGapKey: gapKey })
    try {
      await onLoadTranscriptGap(gap)
    } catch (error) {
      console.error('[Wework] Message area transcript gap load failed', {
        gap,
        gapKey,
        reason,
        error,
      })
    } finally {
      if (owned() && gapLoadOwner === owner) {
        gapLoadOwner = null
        publish({
          loadingTranscriptGapKey:
            state.loadingTranscriptGapKey === gapKey ? null : state.loadingTranscriptGapKey,
        })
      }
    }
  }

  function persist() {
    if (currentScrollKey && lastSnapshot?.key === currentScrollKey)
      setConversationScrollSnapshot(currentScrollKey, lastSnapshot.snapshot)
  }
  function stop() {
    stopObservingLayout()
    cancelMotion()
    reader.dispose()
    persist()
    gapLoadOwner = null
    autoLoadedTranscriptGapKeys.clear()
    publish({ loadingTranscriptGapKey: null })
  }
  return {
    getSnapshot: () => state,
    update(next: ConversationScrollInput, ports: ScrollPorts) {
      ;({ contentRef, virtualizerRef } = ports)
      commit(next)
    },
    subscribe(listener: () => void) {
      stopped = false
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size > 0 || contentLease !== null) return
          stopped = true
          stop()
        })
      }
    },
    bindContent(node: HTMLDivElement, ports: ScrollPorts) {
      ;({ contentRef, virtualizerRef } = ports)
      contentRef.current = node
      const lease = Symbol('conversation-scroll-content')
      const resumed = stopped
      stopped = false
      hasContentPort = true
      contentLease = lease
      contentOwner = ports.owner
      contentOwner.lease = lease
      commit(
        {
          ...(input ?? initialInput),
          scrollRef: ports.scrollRef,
          externalScrollInteractionRef: ports.externalScrollInteractionRef,
        },
        resumed
      )
      return () => {
        if (contentLease !== lease) return
        // Cancel the native animation while this content still owns the viewport.
        cancelNativeFollow()
        contentLease = null
        stopObservingLayout()
        if (ports.owner.lease === lease) {
          ports.owner.lease = null
          if (contentRef.current === node) contentRef.current = null
        }
        persist()
        queueMicrotask(() => {
          if (contentLease !== null) return
          stopped = true
          stop()
        })
      }
    },
    captureNativeScrollRange() {
      if (!owned() || command || inputActive || state.mode !== 'read') return
      reader.captureNativeScrollRange()
    },
    markInput,
    scroll,
    endInput,
    endDrag,
    drag,
    handleTurnNavigationScrollTargetChange,
    handleTurnNavigationLoadStateChange,
    handleContentLayoutChange,
    handleVirtualLayoutChange,
    handleScrollToBottom,
    preserveScrollPositionForNextLayout,
    prepareForHistoryPrepend,
    preserveUserMessagePosition,
    onVirtualScrollAdjustment,
    loadTranscriptGap,
  }
}
