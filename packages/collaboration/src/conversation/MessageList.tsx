import type { UserMessageServices } from './UserMessage'
import { MessageListMessage } from './MessageListMessage'
import {
  isCancelledAssistantMessage,
  shouldHideFailedAssistantContent,
  getDisplayProcessingBlocks,
} from './assistantMessagePresentation'
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import { defaultRangeExtractor, type Range as VirtualRange } from '@tanstack/react-virtual'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import type { RequestUserInputResponse, TurnFileChangesSummary } from '@wegent/chat-core/runtime'
import type {
  RuntimeConversationTurn,
  SubagentBlock,
  WorkbenchMessage,
} from '@wegent/chat-core/runtime-conversation'
import type { MarkdownFileOpenOptions as WorkspaceFileOpenOptions } from '../markdown/MarkdownServices'
import { stripPluginWorkspaceResultMarkers } from '@wegent/chat-core/plugin-workspace-result'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { AssistantThinkingIndicator } from './AssistantThinkingIndicator'
import type { RequestUserInputPayload } from './RequestUserInputCard'
import {
  resolveAsyncRequestUserInputAnswers,
  resolveAsyncRequestUserInputReplies,
} from '@wegent/chat-core/runtime-user-input'
import {
  getMessagePretextIntrinsicHeight,
  getMessageLayoutSignature,
  readMessageLayoutTypography,
  getMessageFontMetricsRevision,
} from './messagePretextLayout'
import type { AssistantPlanOpenRequest } from './AssistantPlanCard'
import {
  cacheConversationVirtualMeasurements,
  getConversationVirtualMeasurements,
} from './conversationViewportCache'
import { SelectionActionsPopover } from './SelectionActionsPopover'
import {
  useConversationVirtualizer,
  type ConversationVirtualizer,
} from './useConversationVirtualizer'
import { useMessageRowMeasure, useMessageRowMeasurements } from './useMessageRowMeasurements'
import {
  createMarkdownWindowingScope,
  MarkdownWindowingContext,
  MarkdownWindowingDisabledContext,
} from '../markdown/MarkdownWindowingScope'
import {
  getConversationDiagnosticContext,
  isConversationDiagnosticsEnabled,
  recordConversationDiagnostic,
} from './conversationDiagnostics'

export interface MessageListProps {
  userMessageServices: UserMessageServices
  virtualize?: boolean
  useContentVisibility?: boolean
  onVirtualMeasurement?: (details: VirtualMessageMeasurement) => void
  renderVisualization?: (
    part: { file: string; mode?: 'wide'; title?: string },
    message: WorkbenchMessage
  ) => ReactNode
  messages: WorkbenchMessage[]
  turns?: RuntimeConversationTurn[]
  scrollElementRef?: RefObject<HTMLDivElement | null>
  scrollTailHeight?: number
  initialDistanceFromBottomPx?: number
  onBeforeUserMessageToggle?: () => void
  onVirtualLayoutChange?: () => void
  className?: string
  conversationKey?: string | number | null
  isWaitingForAssistant?: boolean
  disableContentVisibility?: boolean
  forceVirtualMessageId?: string | null
  searchMessageId?: string
  devices?: Array<{ device_id: string; status: string }>
  onRetryFailedMessage?: (message: WorkbenchMessage) => void
  onSwitchModelForFailedMessage?: (message: WorkbenchMessage) => void
  onLoadFileChangesDiff?: (
    subtaskId: string,
    fileChanges?: TurnFileChangesSummary
  ) => Promise<string>
  onRevertFileChanges?: (
    subtaskId: string,
    fileChanges?: TurnFileChangesSummary
  ) => Promise<TurnFileChangesSummary>
  onOpenFileChangesReview?: (request: {
    subtaskId: string
    loadDiff: () => Promise<string>
    reviewTitle?: string
    defaultFileTreeVisible?: boolean
    focusFilePath?: string
  }) => void
  fileChangesDiffPreviewDisabledSubtaskId?: string | null
  onOpenWorkspaceFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  onOpenLocalSkillFile?: (path: string) => void
  onRequestUserInputSubmit?: (response: RequestUserInputResponse) => void
  onRequestUserInputIgnore?: (payload: RequestUserInputPayload) => void
  onOpenAssistantPlan?: (request: AssistantPlanOpenRequest) => void
  onOpenSubagent?: (block: SubagentBlock) => void
  onEditLastUserMessage?: (
    message: WorkbenchMessage,
    content: string
  ) => Promise<boolean | void> | boolean | void
  canEditLastUserMessage?: boolean
  onForkMessage?: (message: WorkbenchMessage) => Promise<void> | void
  hideRequestUserInputBlocks?: boolean
  hiddenRequestUserInputIds?: ReadonlySet<string>
  onAddSelectionToConversation?: (text: string) => void
  onAskSelectionInSidebar?: (text: string) => void
  virtualScrollAdjustmentEnabled?: boolean
  virtualAnchor?: 'start' | 'end'
  virtualAnchorToEnd?: boolean
  virtualizerRef?: RefObject<ConversationVirtualizer | null>
  onVirtualScrollAdjustment?: (delta: number) => void
  renderGapAfterMessage?: (
    message: WorkbenchMessage,
    nextMessage: WorkbenchMessage | undefined
  ) => ReactNode
}

const EMPTY_TURNS: RuntimeConversationTurn[] = []
const EMPTY_DEVICES: NonNullable<MessageListProps['devices']> = []
const SELECTION_ACTION_GAP = 8
const VIRTUAL_MESSAGE_OVERSCAN = 2
const VIRTUAL_MESSAGE_FULL_MEASUREMENT_COUNT = VIRTUAL_MESSAGE_OVERSCAN * 2 + 1
const MESSAGE_LIST_GAP_PX = 16
const MESSAGE_LIST_PADDING_TOP_PX = 32
const MESSAGE_LIST_PADDING_BOTTOM_PX = 8

interface MessageTextSelection {
  text: string
  left: number
  top: number
  conversationKey?: string | number | null
}
export interface VirtualMessageMeasurement {
  messageId: string | null
  previousSize: number | null
  measuredSize: number
  previousTotalSize: number
  nextTotalSize: number
}

export const MessageList = memo(function MessageList({
  userMessageServices,
  virtualize = true,
  useContentVisibility = false,
  onVirtualMeasurement,
  renderVisualization,
  messages,
  turns = EMPTY_TURNS,
  scrollElementRef,
  initialDistanceFromBottomPx = 0,
  scrollTailHeight = 0,
  onBeforeUserMessageToggle,
  onVirtualLayoutChange,
  className,
  conversationKey,
  isWaitingForAssistant = false,
  disableContentVisibility = false,
  forceVirtualMessageId = null,
  searchMessageId,
  devices = EMPTY_DEVICES,
  onRetryFailedMessage,
  onSwitchModelForFailedMessage,
  onLoadFileChangesDiff,
  onRevertFileChanges,
  onOpenFileChangesReview,
  fileChangesDiffPreviewDisabledSubtaskId,
  onOpenWorkspaceFile,
  onOpenLocalSkillFile,
  onRequestUserInputSubmit,
  onRequestUserInputIgnore,
  onOpenAssistantPlan,
  onOpenSubagent,
  onEditLastUserMessage,
  canEditLastUserMessage = false,
  onForkMessage,
  hideRequestUserInputBlocks,
  hiddenRequestUserInputIds,
  onAddSelectionToConversation,
  onAskSelectionInSidebar,
  virtualAnchorToEnd = true,
  virtualAnchor = 'end',
  virtualScrollAdjustmentEnabled = true,
  virtualizerRef,
  onVirtualScrollAdjustment,
  renderGapAfterMessage,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const [isTextSelectionActive, setIsTextSelectionActive] = useState(false)
  const [textSelection, setTextSelection] = useState<MessageTextSelection | null>(null)
  const [layout, setLayout] = useState(() => ({
    width: 0,
    typography: readMessageLayoutTypography(scrollElementRef?.current),
    fontEpoch: getMessageFontMetricsRevision(),
  }))
  const layoutWidth = layout.width
  const layoutKey = JSON.stringify([
    layout.width,
    className ?? null,
    layout.typography,
    layout.fontEpoch,
  ])
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [submittingEditMessageId, setSubmittingEditMessageId] = useState<string | null>(null)
  const resolvedMessages = useMemo(() => resolveAsyncRequestUserInputAnswers(messages), [messages])
  const replyQuestionsByMessageId = useMemo(
    () => resolveAsyncRequestUserInputReplies(messages),
    [messages]
  )
  const visibleMessages = useMemo(
    () => resolvedMessages.filter(shouldRenderMessage),
    [resolvedMessages]
  )
  const runtimeTurnsById = useMemo(
    () => new Map(turns.flatMap(turn => (turn.id ? [[turn.id, turn] as const] : []))),
    [turns]
  )
  const lastAssistantMessageIdByTurn = useMemo(() => {
    const result = new Map<string, string>()
    visibleMessages.forEach(message => {
      if (message.role === 'assistant' && message.turnId) {
        result.set(message.turnId, message.id)
      }
    })
    return result
  }, [visibleMessages])
  const editableLastUserMessageId = useMemo(
    () =>
      editableLastUserMessage(
        visibleMessages,
        canEditLastUserMessage && Boolean(onEditLastUserMessage)
      )?.id ?? null,
    [canEditLastUserMessage, onEditLastUserMessage, visibleMessages]
  )
  const activeEditingMessageId =
    editingMessageId === editableLastUserMessageId ? editingMessageId : null
  const activeSubmittingEditMessageId =
    submittingEditMessageId === editableLastUserMessageId ? submittingEditMessageId : null
  const shouldShowWaitingIndicator =
    isWaitingForAssistant &&
    !resolvedMessages.some(
      message => message.role === 'assistant' && message.status === 'streaming'
    )
  const virtualMessages = virtualize && scrollElementRef !== undefined
  const hasVisibleContent = visibleMessages.length > 0 || shouldShowWaitingIndicator
  // Validate the actual column before hydrating sizes or preparing the transcript.
  const virtualLayoutReady = virtualMessages && layoutWidth > 0
  const virtualMeasurementKey = conversationKey == null ? null : String(conversationKey)
  const measurementLayout = useMemo(
    () => ({
      key: layoutKey,
      messages: new Map(
        visibleMessages.map(message => [message.id, getMessageLayoutSignature(message)])
      ),
    }),
    [layoutKey, visibleMessages]
  )
  const initialMeasurementsCache = useMemo(
    () =>
      virtualMeasurementKey === null
        ? []
        : (getConversationVirtualMeasurements(virtualMeasurementKey, measurementLayout) ?? []),
    [measurementLayout, virtualMeasurementKey]
  )
  const messageIntrinsicHeights = useMemo(() => {
    if (!virtualLayoutReady) return new Map<string, number>()
    const measuredSizes = new Map(initialMeasurementsCache.map(item => [item.key, item.size]))
    return new Map(
      visibleMessages.map(message => [
        message.id,
        measuredSizes.get(message.id) ??
          getMessagePretextIntrinsicHeight(message, layoutWidth, layout.typography),
      ])
    )
  }, [
    initialMeasurementsCache,
    layoutWidth,
    layout.typography,
    virtualLayoutReady,
    visibleMessages,
  ])
  const listLayoutClass = className
    ? 'mx-auto flex min-w-0 shrink-0 flex-col gap-4 pb-2 pt-8'
    : 'mx-auto flex w-full min-w-0 max-w-3xl shrink-0 flex-col gap-4 px-6 pb-2 pt-8'
  const forcedVirtualMessageIndex = useMemo(
    () =>
      forceVirtualMessageId === null
        ? -1
        : visibleMessages.findIndex(message => message.id === forceVirtualMessageId),
    [forceVirtualMessageId, visibleMessages]
  )
  const streamingVirtualMessageIndex = useMemo(
    () => findLastIndex(visibleMessages, message => message.status === 'streaming'),
    [visibleMessages]
  )
  const getItemKey = useCallback(
    (index: number) => visibleMessages[index]?.id ?? 'assistant-waiting',
    [visibleMessages]
  )
  const estimateSize = useCallback(
    (index: number) =>
      index === visibleMessages.length
        ? 32
        : Math.ceil(messageIntrinsicHeights.get(visibleMessages[index].id) ?? 220),
    [messageIntrinsicHeights, visibleMessages]
  )
  const rangeExtractor = useCallback(
    (range: VirtualRange) => {
      const indexes =
        range.count <= VIRTUAL_MESSAGE_FULL_MEASUREMENT_COUNT
          ? Array.from({ length: range.count }, (_, index) => index)
          : defaultRangeExtractor(range)
      const forcedIndexes = [
        ...new Set([forcedVirtualMessageIndex, streamingVirtualMessageIndex]),
      ].filter(index => index >= 0 && !indexes.includes(index))
      return [...indexes, ...forcedIndexes].sort((left, right) => left - right)
    },
    [forcedVirtualMessageIndex, streamingVirtualMessageIndex]
  )
  const measureElement = useMessageRowMeasure(onVirtualMeasurement)
  const {
    virtualizer: messageVirtualizer,
    tailHeight,
    scrollMargin,
  } = useConversationVirtualizer({
    count: visibleMessages.length + (shouldShowWaitingIndicator ? 1 : 0),
    enabled: virtualLayoutReady,
    getItemKey,
    estimateSize,
    measureElement,
    gap: MESSAGE_LIST_GAP_PX,
    paddingStart: MESSAGE_LIST_PADDING_TOP_PX,
    paddingEnd: MESSAGE_LIST_PADDING_BOTTOM_PX,
    overscan: VIRTUAL_MESSAGE_OVERSCAN,
    anchorTo: virtualAnchor,
    scrollEndThreshold: virtualAnchorToEnd ? 8 : -1,
    followOnAppend: virtualAnchorToEnd ? 'auto' : false,
    rangeExtractor,
    initialMeasurementsCache,
    initialDistanceFromBottomPx,
    scrollTailHeight,
    scrollElementRef,
    listRef,
    virtualizerRef,
    onScrollAdjustment: onVirtualScrollAdjustment,
  })
  messageVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = virtualScrollAdjustmentEnabled
    ? undefined
    : () => false
  const virtualTotalSize = virtualMessages ? messageVirtualizer.getTotalSize() : 0
  const virtualRows = messageVirtualizer.getVirtualItems()
  const { measureRow, measureRows } = useMessageRowMeasurements(
    listRef,
    messageVirtualizer,
    virtualLayoutReady
  )
  const markdownLayoutHandlerRef = useRef<(element: HTMLElement) => void>(() => {})
  const pendingMarkdownLayoutsRef = useRef(new Set<HTMLElement>())
  const markdownWindowingState = useMemo(
    () => ({
      conversationKey,
      layoutKey,
      scope: createMarkdownWindowingScope(
        scrollElementRef,
        element => {
          markdownLayoutHandlerRef.current(element)
        },
        layout.typography.rootFontSize
      ),
    }),
    [conversationKey, scrollElementRef, layoutKey, layout.typography.rootFontSize]
  )
  markdownLayoutHandlerRef.current = element => {
    const list = listRef.current
    if (!list) {
      pendingMarkdownLayoutsRef.current.add(element)
      return
    }
    if (!list.contains(element)) return
    if (!virtualMessages) {
      onVirtualLayoutChange?.()
      return
    }
    const row = element.closest<HTMLElement>('[data-message-row][data-index]')
    if (!row || !list.contains(row)) return
    measureRow(row)
  }

  useEffect(() => {
    const scope = markdownWindowingState.scope
    const scroller = scope.scrollElementRef?.current
    if (!scroller) return
    const renderPendingChunks = () => {
      const startedAt = isConversationDiagnosticsEnabled() ? performance.now() : null
      const renders = scope.getViewportRenders()
      if (renders.length > 0) flushSync(() => renders.forEach(render => render()))
      if (startedAt === null) return
      const elapsedMs = performance.now() - startedAt
      if (elapsedMs >= 16) {
        recordConversationDiagnostic('search-scroll-render', {
          elapsedMs,
          renderedCount: renders.length,
        })
      }
    }
    scroller.addEventListener('scroll', renderPendingChunks, { passive: true })
    return () => scroller.removeEventListener('scroll', renderPendingChunks)
  }, [markdownWindowingState])

  useLayoutEffect(() => {
    if (virtualMessages && !virtualLayoutReady) return
    // Child layout effects run before the list's host ref is attached on first mount.
    const pendingChunks = [...pendingMarkdownLayoutsRef.current]
    pendingMarkdownLayoutsRef.current.clear()
    pendingChunks.forEach(chunk => markdownLayoutHandlerRef.current(chunk))
    if (!virtualMessages) return
    markdownWindowingState.scope.getViewportRenders().forEach(render => render())
    if (isConversationDiagnosticsEnabled()) {
      const scroller = scrollElementRef?.current
      recordConversationDiagnostic('virtual-range', {
        ...getConversationDiagnosticContext(listRef.current),
        rangeStart: messageVirtualizer.range?.startIndex,
        rangeEnd: messageVirtualizer.range?.endIndex,
        renderedCount: virtualRows.length,
        totalSize: virtualTotalSize,
        scrollTop: scroller?.scrollTop,
        scrollHeight: scroller?.scrollHeight,
        clientHeight: scroller?.clientHeight,
        clientWidth: scroller?.clientWidth,
        scrolling: messageVirtualizer.isScrolling,
      })
    }
    onVirtualLayoutChange?.()
  }, [
    markdownWindowingState,
    messageVirtualizer,
    onVirtualLayoutChange,
    scrollElementRef,
    virtualMessages,
    virtualLayoutReady,
    virtualRows,
    virtualTotalSize,
  ])

  const snapshotRef = useRef<{
    layout: typeof measurementLayout
  } | null>(null)
  const uncacheableMessageIdsRef = useRef(new Set<string>())
  useLayoutEffect(() => {
    if (!virtualLayoutReady) return
    listRef.current
      ?.querySelectorAll<HTMLElement>('[data-message-row][data-index]')
      .forEach(row => {
        const id = row.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId
        if (!id) return
        if (
          row.querySelector('[aria-expanded="true"], [data-testid="user-message-editor"]') ||
          id === searchMessageId
        )
          uncacheableMessageIdsRef.current.add(id)
        else uncacheableMessageIdsRef.current.delete(id)
      })
    snapshotRef.current = { layout: measurementLayout }
  })
  useEffect(
    () => () => {
      const snapshot = snapshotRef.current
      if (
        virtualMessages &&
        messageVirtualizer.options.enabled &&
        virtualMeasurementKey !== null &&
        snapshot
      )
        cacheConversationVirtualMeasurements(
          virtualMeasurementKey,
          messageVirtualizer
            .takeSnapshot()
            .filter(item => !uncacheableMessageIdsRef.current.has(String(item.key))),
          snapshot.layout
        )
    },
    [messageVirtualizer, virtualMeasurementKey, virtualMessages]
  )

  useLayoutEffect(() => {
    const element = listRef.current
    if (!element || !virtualMessages) return
    let active = true
    const update = (fontLoaded = false) => {
      const style = getComputedStyle(element)
      const width = Math.max(
        0,
        Math.round(
          element.clientWidth -
            (Number.parseFloat(style.paddingLeft) || 0) -
            (Number.parseFloat(style.paddingRight) || 0)
        )
      )
      const typography = readMessageLayoutTypography(element)
      setLayout(previous => {
        if (
          !fontLoaded &&
          previous.width === width &&
          JSON.stringify(previous.typography) === JSON.stringify(typography)
        )
          return previous
        return {
          width,
          typography,
          fontEpoch: getMessageFontMetricsRevision(),
        }
      })
    }
    update()
    const observer = new ResizeObserver(() => update())
    observer.observe(element)
    const mutation = new MutationObserver(() => update())
    mutation.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class'],
    })
    const fontsLoaded = () => {
      if (active) update(true)
    }
    document.fonts?.addEventListener('loadingdone', fontsLoaded)
    return () => {
      active = false
      observer.disconnect()
      mutation.disconnect()
      document.fonts?.removeEventListener('loadingdone', fontsLoaded)
    }
  }, [hasVisibleContent, scrollElementRef, virtualMessages])

  const previousLayoutKeyRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!virtualLayoutReady || previousLayoutKeyRef.current === layoutKey) return
    const previousKey = previousLayoutKeyRef.current
    previousLayoutKeyRef.current = layoutKey
    if (previousKey === null) return
    messageVirtualizer.measure()
    measureRows(
      Array.from(
        listRef.current?.querySelectorAll<HTMLElement>('[data-message-row][data-index]') ?? []
      )
    )
  }, [layoutKey, measureRows, messageVirtualizer, virtualLayoutReady])

  useEffect(() => {
    if (!useContentVisibility && (!onAddSelectionToConversation || !onAskSelectionInSidebar)) return

    const updateSelectionState = (
      preserveCapturedSelection = false,
      eventTarget?: EventTarget | null
    ) => {
      if (
        isEditableSelectionTarget(eventTarget) ||
        isEditableSelectionTarget(document.activeElement)
      ) {
        setIsTextSelectionActive(false)
        setTextSelection(null)
        return
      }
      const selection = document.getSelection?.()
      const root = listRef.current
      if (!selection || !root || selection.isCollapsed || selection.rangeCount === 0) {
        setIsTextSelectionActive(false)
        if (!preserveCapturedSelection) {
          setTextSelection(null)
        }
        return
      }

      const selectionTouchesList =
        isNodeInsideElement(selection.anchorNode, root) ||
        isNodeInsideElement(selection.focusNode, root)
      if (!selectionTouchesList) {
        setIsTextSelectionActive(false)
        setTextSelection(null)
        return
      }
      setIsTextSelectionActive(useContentVisibility)
      if (!onAddSelectionToConversation || !onAskSelectionInSidebar) return

      const range = selection.getRangeAt(0)
      const selectedMessageBodies = selectableMessageBodiesForRange(root, range)
      if (selectedMessageBodies.length !== 1) {
        setTextSelection(null)
        return
      }

      const text = selection.toString().trim()
      if (!text) {
        setTextSelection(null)
        return
      }
      const rect = range.getBoundingClientRect()
      const nextSelection: MessageTextSelection = {
        text,
        left: Math.min(Math.max(rect.left + rect.width / 2, 120), window.innerWidth - 120),
        top: Math.max(rect.top - SELECTION_ACTION_GAP, 44),
        conversationKey,
      }
      setTextSelection(current =>
        current?.text === nextSelection.text &&
        current.left === nextSelection.left &&
        current.top === nextSelection.top &&
        current.conversationKey === nextSelection.conversationKey
          ? current
          : nextSelection
      )
    }

    const scheduleSelectionUpdate = () => {
      window.requestAnimationFrame(() => updateSelectionState(true))
    }

    const finalizeSelectionUpdate = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-testid="message-selection-actions"]')
      ) {
        return
      }
      updateSelectionState(false, event.target)
    }

    const handleBlur = () => {
      updateSelectionState()
    }

    const handleScroll = () => {
      updateSelectionState(true)
    }

    document.addEventListener('pointerup', finalizeSelectionUpdate)
    document.addEventListener('pointercancel', finalizeSelectionUpdate)
    document.addEventListener('mouseup', finalizeSelectionUpdate)
    document.addEventListener('keyup', finalizeSelectionUpdate)
    document.addEventListener('focusin', finalizeSelectionUpdate)
    document.addEventListener('selectionchange', scheduleSelectionUpdate)
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('blur', handleBlur)

    return () => {
      document.removeEventListener('pointerup', finalizeSelectionUpdate)
      document.removeEventListener('pointercancel', finalizeSelectionUpdate)
      document.removeEventListener('mouseup', finalizeSelectionUpdate)
      document.removeEventListener('keyup', finalizeSelectionUpdate)
      document.removeEventListener('focusin', finalizeSelectionUpdate)
      document.removeEventListener('selectionchange', scheduleSelectionUpdate)
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('blur', handleBlur)
    }
  }, [conversationKey, useContentVisibility, onAddSelectionToConversation, onAskSelectionInSidebar])

  const applySelectionAction = (action: (text: string) => void) => {
    if (!textSelection) return
    action(textSelection.text)
    document.getSelection()?.removeAllRanges()
    setTextSelection(null)
  }

  if (visibleMessages.length === 0 && !shouldShowWaitingIndicator) {
    return null
  }

  const content = (
    <div
      ref={listRef}
      className={cn(listLayoutClass, className, virtualMessages && 'relative gap-0 pb-0 pt-0')}
      style={
        virtualMessages
          ? {
              height: Math.max(0, virtualTotalSize - tailHeight),
            }
          : undefined
      }
    >
      {textSelection && textSelection.conversationKey === conversationKey && (
        <SelectionActionsPopover
          position={{ left: textSelection.left, top: textSelection.top }}
          onAddToConversation={() => applySelectionAction(onAddSelectionToConversation!)}
          onAskInSidebar={() => applySelectionAction(onAskSelectionInSidebar!)}
        />
      )}
      {(virtualMessages
        ? virtualRows.map(virtualRow => ({
            index: virtualRow.index,
            key: virtualRow.key,
            measureRef: undefined,
            style: {
              position: 'absolute',
              left: 0,
              top: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start - scrollMargin}px)`,
            } satisfies CSSProperties,
          }))
        : visibleMessages.map((_, index) => ({
            index,
            key: visibleMessages[index].id,
            measureRef: undefined,
            style: undefined,
          }))
      ).map(row => {
        const { index } = row
        const message = visibleMessages[index]
        if (!message)
          return (
            <article
              key={row.key}
              data-index={index}
              data-message-row
              style={row.style}
              className="min-w-0"
              data-testid="message-assistant-waiting"
            >
              <AssistantThinkingIndicator />
            </article>
          )
        const nextMessage = visibleMessages[index + 1]
        const article = (
          <article
            className={cn(
              'min-w-0',
              useContentVisibility &&
                !disableContentVisibility &&
                searchMessageId !== message.id &&
                !isTextSelectionActive &&
                '[content-visibility:auto]',
              message.role === 'user' && 'flex justify-end'
            )}
            data-message-id={message.id}
            data-testid={`message-${message.role}`}
          >
            <MessageListMessage
              message={message}
              runtimeTurn={
                message.turnId && lastAssistantMessageIdByTurn.get(message.turnId) === message.id
                  ? runtimeTurnsById.get(message.turnId)
                  : undefined
              }
              forceExpanded={searchMessageId === message.id}
              isActiveTurn={isWaitingForAssistant && index === visibleMessages.length - 1}
              userMessageServices={userMessageServices}
              renderVisualization={renderVisualization}
              conversationKey={conversationKey}
              devices={devices}
              replyQuestions={replyQuestionsByMessageId.get(message.id)}
              editable={message.id === editableLastUserMessageId}
              editing={message.id === activeEditingMessageId}
              editSubmitting={message.id === activeSubmittingEditMessageId}
              setEditingMessageId={setEditingMessageId}
              setSubmittingEditMessageId={setSubmittingEditMessageId}
              onBeforeUserMessageToggle={onBeforeUserMessageToggle}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
              onOpenLocalSkillFile={onOpenLocalSkillFile}
              onEditLastUserMessage={onEditLastUserMessage}
              onRetryFailedMessage={onRetryFailedMessage}
              onSwitchModelForFailedMessage={onSwitchModelForFailedMessage}
              onLoadFileChangesDiff={onLoadFileChangesDiff}
              onRevertFileChanges={onRevertFileChanges}
              onOpenFileChangesReview={onOpenFileChangesReview}
              fileChangesDiffPreviewDisabledSubtaskId={fileChangesDiffPreviewDisabledSubtaskId}
              onRequestUserInputSubmit={onRequestUserInputSubmit}
              onRequestUserInputIgnore={onRequestUserInputIgnore}
              onOpenAssistantPlan={onOpenAssistantPlan}
              onOpenSubagent={onOpenSubagent}
              hideRequestUserInputBlocks={hideRequestUserInputBlocks}
              hiddenRequestUserInputIds={hiddenRequestUserInputIds}
              onForkMessage={onForkMessage}
            />
          </article>
        )
        const searchableArticle = (
          <MarkdownWindowingDisabledContext.Provider value={searchMessageId === message.id}>
            {article}
          </MarkdownWindowingDisabledContext.Provider>
        )
        const gap = renderGapAfterMessage?.(message, nextMessage)
        return virtualMessages ? (
          <div
            key={row.key}
            ref={row.measureRef}
            data-index={index}
            data-message-row
            style={row.style}
          >
            {searchableArticle}
            {gap}
          </div>
        ) : (
          <Fragment key={row.key}>
            {searchableArticle}
            {gap}
          </Fragment>
        )
      })}
      {!virtualMessages && shouldShowWaitingIndicator && (
        <article className="min-w-0" data-testid="message-assistant-waiting">
          <AssistantThinkingIndicator />
        </article>
      )}
    </div>
  )
  return (
    <MarkdownWindowingContext.Provider value={markdownWindowingState.scope}>
      {content}
    </MarkdownWindowingContext.Provider>
  )
})

function selectableMessageBodiesForRange(root: HTMLElement, range: Range): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-message-selectable-text]')).filter(
    element => selectedTextWithinElement(range, element).trim().length > 0
  )
}

function selectedTextWithinElement(range: Range, element: HTMLElement): string {
  if (!range.intersectsNode(element)) return ''

  const intersection = document.createRange()
  intersection.selectNodeContents(element)
  if (intersection.compareBoundaryPoints(Range.START_TO_START, range) < 0) {
    intersection.setStart(range.startContainer, range.startOffset)
  }
  if (intersection.compareBoundaryPoints(Range.END_TO_END, range) > 0) {
    intersection.setEnd(range.endContainer, range.endOffset)
  }
  return intersection.toString()
}

function isNodeInsideElement(node: Node | null, root: HTMLElement): boolean {
  if (!node) return false

  if (node.nodeType === Node.ELEMENT_NODE) {
    return root.contains(node)
  }

  return Boolean(node.parentElement && root.contains(node.parentElement))
}

function isEditableSelectionTarget(target?: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'input, textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'
      )
    )
  )
}

function shouldRenderMessage(message: WorkbenchMessage): boolean {
  if (message.role !== 'assistant') return true
  if (message.status === 'streaming' || message.status === 'failed') return true
  if (isCancelledAssistantMessage(message)) return true
  if (message.fileChanges) return true
  if (message.references?.length || message.memoryCitations?.length) {
    return true
  }

  const visibleContent = shouldHideFailedAssistantContent(message)
    ? ''
    : stripPluginWorkspaceResultMarkers(message.content)
  if (visibleContent.trim()) return true

  return getDisplayProcessingBlocks(message.blocks).length > 0
}

function editableLastUserMessage(
  messages: WorkbenchMessage[],
  canEdit: boolean
): WorkbenchMessage | null {
  if (!canEdit) return null

  const lastUserIndex = findLastIndex(messages, message => message.role === 'user')
  if (lastUserIndex === -1) return null

  const followingMessages = messages.slice(lastUserIndex + 1)
  if (followingMessages.length === 0) return null
  if (followingMessages.some(message => message.status === 'streaming')) return null
  if (!followingMessages.some(message => message.role === 'assistant')) return null

  return messages[lastUserIndex] ?? null
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item !== undefined && predicate(item)) return index
  }
  return -1
}
