import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { useDOMEvent, useWindowEvent } from '../dom-events'
import type { ScrollableMessageAreaProps } from './scrollableMessageTypes'
import { scrollPositionKey } from './conversationScrollGeometry'
import { useConversationFooterHeight } from './useConversationFooterHeight'
import type { ConversationVirtualizer } from './useConversationVirtualizer'
import {
  createConversationScrollState,
  type ConversationScrollInput,
} from './conversationScrollState'
import {
  RuntimeTranscriptGapMarker,
  runtimeTranscriptGapBetween,
  runtimeTranscriptGapKey,
} from './RuntimeTranscriptGapMarker'

type Options = Pick<
  ScrollableMessageAreaProps,
  | 'messages'
  | 'externalScrollRef'
  | 'externalScrollInteractionRef'
  | 'loading'
  | 'isWaitingForAssistant'
  | 'conversationKey'
  | 'onLoadTranscriptGap'
  | 'loadedTranscriptRanges'
  | 'autoScrollSuspended'
  | 'initialScrollPosition'
>

/** Application scroll semantics belong to the committed viewport resource. */
export function useConversationScrollController(options: Options) {
  const {
    messages,
    externalScrollRef,
    externalScrollInteractionRef,
    loading,
    isWaitingForAssistant,
    conversationKey,
    onLoadTranscriptGap,
    loadedTranscriptRanges,
    autoScrollSuspended,
    initialScrollPosition,
  } = options
  const internalScrollRef = useRef<HTMLDivElement>(null)
  const scrollRef = externalScrollRef ?? internalScrollRef
  const contentNode = useRef<HTMLDivElement>(null)
  const stickyFooterRef = useRef<HTMLDivElement>(null)
  const contentFooterRef = useRef<HTMLDivElement>(null)
  const scrollTailHeight = useConversationFooterHeight(contentFooterRef, stickyFooterRef)
  const virtualizerRef = useRef<ConversationVirtualizer | null>(null)
  const currentScrollKey = scrollPositionKey(conversationKey)
  const ports = useMemo(
    () => ({
      contentRef: contentNode,
      virtualizerRef,
      scrollRef,
      externalScrollInteractionRef,
      owner: { lease: null as symbol | null },
    }),
    [scrollRef, externalScrollInteractionRef]
  )
  const input = useMemo<ConversationScrollInput>(
    () => ({
      messages,
      scrollRef,
      externalScrollInteractionRef,
      loading,
      isWaitingForAssistant,
      onLoadTranscriptGap,
      autoScrollSuspended,
      initialScrollPosition,
    }),
    [
      messages,
      scrollRef,
      externalScrollInteractionRef,
      loading,
      isWaitingForAssistant,
      onLoadTranscriptGap,
      autoScrollSuspended,
      initialScrollPosition,
    ]
  )
  const initialConfiguration = {
    messages,
    loading,
    isWaitingForAssistant,
    onLoadTranscriptGap,
    autoScrollSuspended,
    initialScrollPosition,
  }
  const [owner, setOwner] = useState(() => ({
    key: currentScrollKey,
    resource: createConversationScrollState(currentScrollKey, initialConfiguration),
  }))
  let resource = owner.resource
  if (owner.key !== currentScrollKey) {
    resource = createConversationScrollState(currentScrollKey, initialConfiguration)
    setOwner({ key: currentScrollKey, resource })
  }
  const subscribe = useCallback(
    (listener: () => void) => resource.subscribe(listener, input, ports),
    [resource, input, ports]
  )
  const snapshot = useSyncExternalStore(subscribe, resource.getSnapshot, resource.getSnapshot)
  const contentRef = contentNode
  const bindContentRef = useCallback(
    (node: HTMLDivElement | null) => {
      contentNode.current = node
      if (!node) return
      const release = resource.bindContent(node, ports)
      return release
    },
    [resource, ports]
  )
  const nativeTargets = [
    snapshot.viewport,
    snapshot.interaction === snapshot.viewport ? null : snapshot.interaction,
  ]
  useDOMEvent(nativeTargets[0], 'wheel', resource.markInput, { passive: true })
  useDOMEvent(nativeTargets[1], 'wheel', resource.markInput, { passive: true })
  useDOMEvent(nativeTargets[0], 'pointerdown', resource.markInput, { capture: true })
  useDOMEvent(nativeTargets[1], 'pointerdown', resource.markInput, { capture: true })
  useDOMEvent(nativeTargets[0], 'touchmove', resource.markInput, { passive: true })
  useDOMEvent(nativeTargets[1], 'touchmove', resource.markInput, { passive: true })
  useDOMEvent(nativeTargets[0], 'keydown', resource.markInput, { capture: true })
  useDOMEvent(nativeTargets[1], 'keydown', resource.markInput, { capture: true })
  useDOMEvent<PointerEvent>(snapshot.interaction, 'pointermove', resource.drag, { capture: true })
  useDOMEvent(snapshot.viewport, 'scroll', resource.scroll, { passive: true })
  useDOMEvent(snapshot.viewport, 'scrollend', resource.endInput)
  useWindowEvent('pointerup', resource.endDrag)
  useWindowEvent('pointercancel', resource.endDrag)
  useWindowEvent('lostpointercapture', resource.endDrag)
  const renderTranscriptGapAfterMessage = useCallback(
    (message: WorkbenchMessage, nextMessage: WorkbenchMessage | undefined) => {
      const gap = runtimeTranscriptGapBetween(message, nextMessage, loadedTranscriptRanges)
      return gap ? (
        <RuntimeTranscriptGapMarker
          key={runtimeTranscriptGapKey(gap)}
          gap={gap}
          loading={snapshot.loadingTranscriptGapKey === runtimeTranscriptGapKey(gap)}
          scrollRef={scrollRef}
          onLoad={onLoadTranscriptGap ? resource.loadTranscriptGap : undefined}
        />
      ) : null
    },
    [
      loadedTranscriptRanges,
      snapshot.loadingTranscriptGapKey,
      scrollRef,
      onLoadTranscriptGap,
      resource,
    ]
  )
  return {
    internalScrollRef,
    scrollRef,
    contentRef,
    bindContentRef,
    stickyFooterRef,
    contentFooterRef,
    scrollTailHeight,
    virtualizerRef,
    currentScrollKey,
    showScrollButton: snapshot.showScrollButton,
    turnNavigationLoading: snapshot.turnNavigationLoading,
    turnNavigationTargetMessageId: snapshot.turnNavigationTargetMessageId,
    handleTurnNavigationScrollTargetChange: resource.handleTurnNavigationScrollTargetChange,
    handleTurnNavigationLoadStateChange: resource.handleTurnNavigationLoadStateChange,
    handleContentLayoutChange: resource.handleContentLayoutChange,
    handleVirtualLayoutChange: resource.handleVirtualLayoutChange,
    handleScrollToBottom: resource.handleScrollToBottom,
    preserveScrollPositionForNextLayout: resource.preserveScrollPositionForNextLayout,
    prepareForHistoryPrepend: resource.prepareForHistoryPrepend,
    preserveUserMessagePosition: resource.preserveUserMessagePosition,
    renderTranscriptGapAfterMessage,
    onVirtualScrollAdjustment: resource.onVirtualScrollAdjustment,
    captureNativeScrollRange: resource.captureNativeScrollRange,
    virtualAnchorToEnd:
      snapshot.virtualAnchorToEnd &&
      !messages.some(message => message.status === 'streaming') &&
      !autoScrollSuspended,
    virtualAnchor:
      snapshot.mode === 'navigate' || snapshot.mode === 'drag'
        ? ('start' as const)
        : ('end' as const),
    virtualScrollAdjustmentEnabled: snapshot.mode === 'read',
  }
}
