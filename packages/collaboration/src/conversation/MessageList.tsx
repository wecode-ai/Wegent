import { UserMessage, type UserMessageServices } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import {
  isCancelledAssistantMessage,
  shouldHideFailedAssistantContent,
  getDisplayProcessingBlocks,
} from "./assistantMessagePresentation";
import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { defaultRangeExtractor } from "@tanstack/react-virtual";
import type { VirtualItem } from "@tanstack/react-virtual";
import type { CSSProperties, ReactNode, RefObject } from "react";
import type {
  RequestUserInputResponse,
  TurnFileChangesSummary,
} from "@wegent/chat-core/runtime";
import type {
  SubagentBlock,
  WorkbenchMessage,
} from "@wegent/chat-core/runtime-conversation";
import type { MarkdownFileOpenOptions as WorkspaceFileOpenOptions } from "../markdown/MarkdownServices";
import { stripPluginWorkspaceResultMarkers } from "@wegent/chat-core/plugin-workspace-result";
import { activityClassNames as cn } from "../issue-detail/activityClassNames";
import { AssistantThinkingIndicator } from "./AssistantThinkingIndicator";
import type { RequestUserInputPayload } from "./RequestUserInputCard";
import { getMessagePretextIntrinsicHeight } from "./messagePretextLayout";
import type { AssistantPlanOpenRequest } from "./AssistantPlanCard";
import {
  cacheConversationVirtualMeasurements,
  getConversationVirtualMeasurements,
} from "./conversationViewportCache";
import { SelectionActionsPopover } from "./SelectionActionsPopover";
import { useBottomOriginVirtualizer } from "./useBottomOriginVirtualizer";

export interface MessageListProps {
  userMessageServices: UserMessageServices;
  virtualize?: boolean;
  useContentVisibility?: boolean;
  onVirtualMeasurement?: (details: VirtualMessageMeasurement) => void;
  renderVisualization?: (
    part: { file: string; mode?: "wide"; title?: string },
    message: WorkbenchMessage,
  ) => ReactNode;
  messages: WorkbenchMessage[];
  scrollElementRef?: RefObject<HTMLDivElement | null>;
  initialDistanceFromBottomPx?: number;
  onBeforeUserMessageToggle?: () => void;
  onVirtualLayoutChange?: () => void;
  className?: string;
  conversationKey?: string | number | null;
  isWaitingForAssistant?: boolean;
  disableContentVisibility?: boolean;
  forceVirtualMessageId?: string | null;
  devices?: Array<{ device_id: string; status: string }>;
  onRetryFailedMessage?: (message: WorkbenchMessage) => void;
  onSwitchModelForFailedMessage?: (message: WorkbenchMessage) => void;
  onLoadFileChangesDiff?: (
    subtaskId: string,
    fileChanges?: TurnFileChangesSummary,
  ) => Promise<string>;
  onRevertFileChanges?: (
    subtaskId: string,
    fileChanges?: TurnFileChangesSummary,
  ) => Promise<TurnFileChangesSummary>;
  onOpenFileChangesReview?: (request: {
    subtaskId: string;
    loadDiff: () => Promise<string>;
    reviewTitle?: string;
    defaultFileTreeVisible?: boolean;
    focusFilePath?: string;
  }) => void;
  fileChangesDiffPreviewDisabledSubtaskId?: string | null;
  onOpenWorkspaceFile?: (
    path: string,
    options?: WorkspaceFileOpenOptions,
  ) => void;
  onOpenLocalSkillFile?: (path: string) => void;
  onRequestUserInputSubmit?: (response: RequestUserInputResponse) => void;
  onRequestUserInputIgnore?: (payload: RequestUserInputPayload) => void;
  onOpenAssistantPlan?: (request: AssistantPlanOpenRequest) => void;
  onOpenSubagent?: (block: SubagentBlock) => void;
  onEditLastUserMessage?: (
    message: WorkbenchMessage,
    content: string,
  ) => Promise<boolean | void> | boolean | void;
  canEditLastUserMessage?: boolean;
  onForkMessage?: (message: WorkbenchMessage) => Promise<void> | void;
  hideRequestUserInputBlocks?: boolean;
  hiddenRequestUserInputIds?: ReadonlySet<string>;
  onAddSelectionToConversation?: (text: string) => void;
  onAskSelectionInSidebar?: (text: string) => void;
  virtualAnchorToEnd?: boolean;
  bottomOrigin?: boolean;
  renderGapAfterMessage?: (
    message: WorkbenchMessage,
    nextMessage: WorkbenchMessage | undefined,
  ) => ReactNode;
}

const MESSAGE_LAYOUT_RESIZE_SETTLE_MS = 120;
const SELECTION_ACTION_GAP = 8;
const VIRTUAL_MESSAGE_OVERSCAN = 2;
const VIRTUAL_MESSAGE_FULL_MEASUREMENT_COUNT = VIRTUAL_MESSAGE_OVERSCAN * 2 + 1;
const MESSAGE_LIST_GAP_PX = 16;
const MESSAGE_LIST_PADDING_TOP_PX = 32;
const MESSAGE_LIST_PADDING_BOTTOM_PX = 8;
const preserveScrollPositionOutsideVirtualizer = () => false;

interface MessageTextSelection {
  text: string;
  left: number;
  top: number;
  conversationKey?: string | number | null;
}
export interface VirtualMessageMeasurement {
  messageId: string | null;
  previousSize: number | null;
  measuredSize: number;
  previousTotalSize: number;
  nextTotalSize: number;
}

export const MessageList = memo(function MessageList({
  userMessageServices,
  virtualize = true,
  useContentVisibility = false,
  onVirtualMeasurement,
  renderVisualization,
  messages,
  scrollElementRef,
  initialDistanceFromBottomPx = 0,
  onBeforeUserMessageToggle,
  onVirtualLayoutChange,
  className,
  conversationKey,
  isWaitingForAssistant = false,
  disableContentVisibility = false,
  forceVirtualMessageId = null,
  devices = [],
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
  bottomOrigin = false,
  renderGapAfterMessage,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const layoutWidthUpdateTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const previousVisibleMessageIdsRef = useRef<string[]>([]);
  const [isTextSelectionActive, setIsTextSelectionActive] = useState(false);
  const [textSelection, setTextSelection] =
    useState<MessageTextSelection | null>(null);
  const [layoutWidth, setLayoutWidth] = useState(0);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [submittingEditMessageId, setSubmittingEditMessageId] = useState<
    string | null
  >(null);
  const visibleMessages = useMemo(
    () => messages.filter(shouldRenderMessage),
    [messages],
  );
  const editableLastUserMessageId = useMemo(
    () =>
      editableLastUserMessage(
        visibleMessages,
        canEditLastUserMessage && Boolean(onEditLastUserMessage),
      )?.id ?? null,
    [canEditLastUserMessage, onEditLastUserMessage, visibleMessages],
  );
  const activeEditingMessageId =
    editingMessageId === editableLastUserMessageId ? editingMessageId : null;
  const activeSubmittingEditMessageId =
    submittingEditMessageId === editableLastUserMessageId
      ? submittingEditMessageId
      : null;
  const shouldShowWaitingIndicator =
    isWaitingForAssistant &&
    !messages.some(
      (message) =>
        message.role === "assistant" && message.status === "streaming",
    );
  const messageIntrinsicHeights = useMemo(() => {
    return new Map(
      visibleMessages.map((message) => [
        message.id,
        getMessagePretextIntrinsicHeight(message, layoutWidth),
      ]),
    );
  }, [layoutWidth, visibleMessages]);
  const listLayoutClass = className
    ? "mx-auto flex min-w-0 flex-col gap-4 pb-2 pt-8"
    : "mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4 px-6 pb-2 pt-8";
  const virtualMessages = virtualize && scrollElementRef !== undefined;
  const virtualMeasurementKey =
    conversationKey == null ? null : String(conversationKey);
  const forcedVirtualMessageIndex = useMemo(
    () =>
      forceVirtualMessageId === null
        ? -1
        : visibleMessages.findIndex(
            (message) => message.id === forceVirtualMessageId,
          ),
    [forceVirtualMessageId, visibleMessages],
  );
  const streamingVirtualMessageIndex = useMemo(
    () =>
      findLastIndex(
        visibleMessages,
        (message) => message.status === "streaming",
      ),
    [visibleMessages],
  );
  const initialMeasurementsCache = useMemo(
    () => getVirtualMeasurementSnapshot(virtualMeasurementKey, visibleMessages),
    [virtualMeasurementKey, visibleMessages],
  );
  const initialVirtualContentHeight = useMemo(() => {
    const measuredSizes = new Map(
      initialMeasurementsCache.map((item) => [item.key, item.size]),
    );
    return (
      MESSAGE_LIST_PADDING_TOP_PX +
      MESSAGE_LIST_PADDING_BOTTOM_PX +
      visibleMessages.reduce((total, message, index) => {
        const size =
          measuredSizes.get(message.id) ??
          Math.ceil(messageIntrinsicHeights.get(message.id) ?? 220);
        const gap =
          index < visibleMessages.length - 1 ? MESSAGE_LIST_GAP_PX : 0;
        return total + size + gap;
      }, 0)
    );
  }, [initialMeasurementsCache, messageIntrinsicHeights, visibleMessages]);
  const messageVirtualizer = useBottomOriginVirtualizer({
    bottomOrigin,
    count: visibleMessages.length,
    enabled: virtualMessages,
    getItemKey: (index) => visibleMessages[index]?.id ?? index,
    estimateSize: (index) => {
      const message = visibleMessages[index];
      return Math.ceil(
        (message && messageIntrinsicHeights.get(message.id)) ?? 220,
      );
    },
    gap: MESSAGE_LIST_GAP_PX,
    paddingStart: MESSAGE_LIST_PADDING_TOP_PX,
    paddingEnd: MESSAGE_LIST_PADDING_BOTTOM_PX,
    overscan: VIRTUAL_MESSAGE_OVERSCAN,
    anchorTo: virtualAnchorToEnd ? "end" : "start",
    followOnAppend: virtualAnchorToEnd ? "auto" : false,
    rangeExtractor: (range) => {
      const indexes =
        range.count <= VIRTUAL_MESSAGE_FULL_MEASUREMENT_COUNT
          ? Array.from({ length: range.count }, (_, index) => index)
          : defaultRangeExtractor(range);
      const forcedIndexes = [
        ...new Set([forcedVirtualMessageIndex, streamingVirtualMessageIndex]),
      ].filter((index) => index >= 0 && !indexes.includes(index));
      return [...indexes, ...forcedIndexes].sort((left, right) => left - right);
    },
    initialMeasurementsCache,
    initialContentHeightPx: initialVirtualContentHeight,
    initialDistanceFromBottomPx,
    positionKey: conversationKey,
    scrollElementRef,
    shouldAdjustScrollPositionOnItemSizeChange: bottomOrigin
      ? undefined
      : preserveScrollPositionOutsideVirtualizer,
  });
  const virtualTotalSize = virtualMessages
    ? messageVirtualizer.getTotalSize()
    : 0;
  const virtualRows = messageVirtualizer.getVirtualItems();

  useLayoutEffect(() => {
    if (virtualMessages) onVirtualLayoutChange?.();
  }, [onVirtualLayoutChange, virtualMessages, virtualRows]);

  useLayoutEffect(() => {
    const previousIds = previousVisibleMessageIdsRef.current;
    const nextIds = visibleMessages.map((message) => message.id);
    previousVisibleMessageIdsRef.current = nextIds;
    if (!virtualMessages || previousIds.length === 0) return;

    const firstDifferentIndex = nextIds.findIndex(
      (id, index) => previousIds[index] !== id,
    );
    if (firstDifferentIndex < 0 && previousIds.length === nextIds.length)
      return;
    const changedIndex =
      firstDifferentIndex >= 0
        ? firstDifferentIndex
        : Math.min(previousIds.length, nextIds.length);

    const virtualItemsByIndex = new Map(
      messageVirtualizer.getVirtualItems().map((item) => [item.index, item]),
    );
    listRef.current
      ?.querySelectorAll<HTMLElement>("[data-index]")
      .forEach((row) => {
        const index = Number(row.dataset.index);
        if (!Number.isInteger(index) || index < changedIndex) return;

        const virtualItem = virtualItemsByIndex.get(index);
        if (!virtualItem) return;
        const measuredSize = Math.ceil(row.getBoundingClientRect().height);
        if (virtualItem.size !== measuredSize) {
          messageVirtualizer.resizeItem(index, measuredSize);
        }
      });
  }, [messageVirtualizer, virtualMessages, visibleMessages]);

  useLayoutEffect(() => {
    if (
      !virtualMessages ||
      streamingVirtualMessageIndex < 0 ||
      streamingVirtualMessageIndex === visibleMessages.length - 1
    ) {
      return;
    }
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${streamingVirtualMessageIndex}"]`,
    );
    if (!row) return;

    const virtualItem = messageVirtualizer
      .getVirtualItems()
      .find((item) => item.index === streamingVirtualMessageIndex);
    const previousSize = virtualItem?.size;
    const previousTotalSize = messageVirtualizer.getTotalSize();
    const measuredSize = Math.ceil(row.getBoundingClientRect().height);
    messageVirtualizer.resizeItem(streamingVirtualMessageIndex, measuredSize);

    if (previousSize !== measuredSize) {
      onVirtualMeasurement?.({
        messageId: visibleMessages[streamingVirtualMessageIndex]?.id ?? null,
        previousSize: previousSize ?? null,
        measuredSize,
        previousTotalSize,
        nextTotalSize: messageVirtualizer.getTotalSize(),
      });
    }
  }, [
    messageVirtualizer,
    streamingVirtualMessageIndex,
    virtualMessages,
    visibleMessages,
    onVirtualMeasurement,
  ]);

  useEffect(
    () => () => {
      if (!virtualMessages || virtualMeasurementKey === null) return;
      cacheConversationVirtualMeasurements(
        virtualMeasurementKey,
        messageVirtualizer.takeSnapshot(),
      );
    },
    [messageVirtualizer, virtualMeasurementKey, virtualMessages],
  );

  useLayoutEffect(() => {
    if (!virtualMessages) return;
    const element = listRef.current;
    if (!element) return;

    const updateLayoutWidth = () => {
      setLayoutWidth((currentWidth) => {
        const nextWidth = element.clientWidth;
        return nextWidth === currentWidth ? currentWidth : nextWidth;
      });
    };

    const scheduleLayoutWidthUpdate = () => {
      if (layoutWidthUpdateTimerRef.current !== null) {
        clearTimeout(layoutWidthUpdateTimerRef.current);
      }

      layoutWidthUpdateTimerRef.current = setTimeout(() => {
        layoutWidthUpdateTimerRef.current = null;
        updateLayoutWidth();
      }, MESSAGE_LAYOUT_RESIZE_SETTLE_MS);
    };

    updateLayoutWidth();
    if (typeof ResizeObserver === "undefined") return;

    const resizeObserver = new ResizeObserver(scheduleLayoutWidthUpdate);
    resizeObserver.observe(element);
    return () => {
      resizeObserver.disconnect();
      if (layoutWidthUpdateTimerRef.current !== null) {
        clearTimeout(layoutWidthUpdateTimerRef.current);
        layoutWidthUpdateTimerRef.current = null;
      }
    };
  }, [virtualMessages]);

  useEffect(() => {
    if (
      !useContentVisibility &&
      (!onAddSelectionToConversation || !onAskSelectionInSidebar)
    )
      return;

    const updateSelectionState = (preserveCapturedSelection = false) => {
      const selection = document.getSelection?.();
      const root = listRef.current;
      if (
        !selection ||
        !root ||
        selection.isCollapsed ||
        selection.rangeCount === 0
      ) {
        setIsTextSelectionActive(false);
        if (!preserveCapturedSelection) {
          setTextSelection(null);
        }
        return;
      }

      const selectionTouchesList =
        isNodeInsideElement(selection.anchorNode, root) ||
        isNodeInsideElement(selection.focusNode, root);
      setIsTextSelectionActive(useContentVisibility && selectionTouchesList);
      if (!onAddSelectionToConversation || !onAskSelectionInSidebar) return;

      const range = selection.getRangeAt(0);
      const selectedMessageBodies = selectableMessageBodiesForRange(
        root,
        range,
      );
      if (selectedMessageBodies.length !== 1) {
        setTextSelection(null);
        return;
      }

      const text = selection.toString().trim();
      if (!text) {
        setTextSelection(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      setTextSelection({
        text,
        left: Math.min(
          Math.max(rect.left + rect.width / 2, 120),
          window.innerWidth - 120,
        ),
        top: Math.max(rect.top - SELECTION_ACTION_GAP, 44),
        conversationKey,
      });
    };

    const scheduleSelectionUpdate = () => {
      window.requestAnimationFrame(() => updateSelectionState(true));
    };

    const finalizeSelectionUpdate = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-testid="message-selection-actions"]')
      ) {
        return;
      }
      updateSelectionState();
    };

    const handleBlur = () => {
      updateSelectionState();
    };

    const handleScroll = () => {
      updateSelectionState(true);
    };

    document.addEventListener("pointerup", finalizeSelectionUpdate);
    document.addEventListener("pointercancel", finalizeSelectionUpdate);
    document.addEventListener("mouseup", finalizeSelectionUpdate);
    document.addEventListener("keyup", finalizeSelectionUpdate);
    document.addEventListener("selectionchange", scheduleSelectionUpdate);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("blur", handleBlur);

    return () => {
      document.removeEventListener("pointerup", finalizeSelectionUpdate);
      document.removeEventListener("pointercancel", finalizeSelectionUpdate);
      document.removeEventListener("mouseup", finalizeSelectionUpdate);
      document.removeEventListener("keyup", finalizeSelectionUpdate);
      document.removeEventListener("selectionchange", scheduleSelectionUpdate);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("blur", handleBlur);
    };
  }, [
    conversationKey,
    useContentVisibility,
    onAddSelectionToConversation,
    onAskSelectionInSidebar,
  ]);

  const applySelectionAction = (action: (text: string) => void) => {
    if (!textSelection) return;
    action(textSelection.text);
    document.getSelection()?.removeAllRanges();
    setTextSelection(null);
  };

  if (visibleMessages.length === 0 && !shouldShowWaitingIndicator) {
    return null;
  }

  return (
    <div
      ref={listRef}
      className={cn(
        listLayoutClass,
        className,
        virtualMessages && "relative gap-0 pb-0 pt-0",
      )}
      style={
        virtualMessages
          ? {
              height:
                virtualTotalSize +
                (shouldShowWaitingIndicator ? MESSAGE_LIST_GAP_PX + 32 : 0),
            }
          : undefined
      }
    >
      {textSelection && textSelection.conversationKey === conversationKey && (
        <SelectionActionsPopover
          position={{ left: textSelection.left, top: textSelection.top }}
          onAddToConversation={() =>
            applySelectionAction(onAddSelectionToConversation!)
          }
          onAskInSidebar={() => applySelectionAction(onAskSelectionInSidebar!)}
        />
      )}
      {(virtualMessages
        ? virtualRows.map((virtualRow) => ({
            index: virtualRow.index,
            key: virtualRow.key,
            measureRef: messageVirtualizer.measureElement,
            style: {
              position: "absolute",
              left: 0,
              top: 0,
              width: "100%",
              transform: `translateY(${virtualRow.start}px)`,
            } satisfies CSSProperties,
          }))
        : visibleMessages.map((_, index) => ({
            index,
            key: visibleMessages[index].id,
            measureRef: undefined,
            style: undefined,
          }))
      ).map((row) => {
        const { index } = row;
        const message = visibleMessages[index];
        const nextMessage = visibleMessages[index + 1];
        const article = (
          <article
            className={cn(
              "min-w-0",
              useContentVisibility &&
                !disableContentVisibility &&
                !isTextSelectionActive &&
                "[content-visibility:auto]",
              message.role === "user" && "flex justify-end",
            )}
            data-message-id={message.id}
            data-testid={`message-${message.role}`}
          >
            {message.role === "user" ? (
              <UserMessage
                services={userMessageServices}
                message={message}
                onBeforeToggle={onBeforeUserMessageToggle}
                onOpenWorkspaceFile={onOpenWorkspaceFile}
                onOpenLocalSkillFile={onOpenLocalSkillFile}
                editable={message.id === editableLastUserMessageId}
                editing={message.id === activeEditingMessageId}
                editSubmitting={message.id === activeSubmittingEditMessageId}
                onStartEdit={() => setEditingMessageId(message.id)}
                onCancelEdit={() => setEditingMessageId(null)}
                onSubmitEdit={async (content) => {
                  if (!onEditLastUserMessage) return false;
                  setSubmittingEditMessageId(message.id);
                  try {
                    const result = await onEditLastUserMessage(
                      message,
                      content,
                    );
                    if (result !== false) {
                      setEditingMessageId(null);
                    }
                    return result;
                  } finally {
                    setSubmittingEditMessageId((current) =>
                      current === message.id ? null : current,
                    );
                  }
                }}
              />
            ) : (
              <AssistantMessage
                imageServices={userMessageServices.images}
                renderVisualization={
                  renderVisualization
                    ? (part) => renderVisualization(part, message)
                    : undefined
                }
                message={message}
                conversationKey={conversationKey}
                isActiveTurn={
                  isWaitingForAssistant && index === visibleMessages.length - 1
                }
                devices={devices}
                onRetryFailedMessage={onRetryFailedMessage}
                onSwitchModelForFailedMessage={onSwitchModelForFailedMessage}
                onLoadFileChangesDiff={onLoadFileChangesDiff}
                onRevertFileChanges={onRevertFileChanges}
                onOpenFileChangesReview={onOpenFileChangesReview}
                fileChangesDiffPreviewDisabledSubtaskId={
                  fileChangesDiffPreviewDisabledSubtaskId
                }
                onOpenWorkspaceFile={onOpenWorkspaceFile}
                onRequestUserInputSubmit={onRequestUserInputSubmit}
                onRequestUserInputIgnore={onRequestUserInputIgnore}
                onOpenAssistantPlan={onOpenAssistantPlan}
                onOpenSubagent={onOpenSubagent}
                hideRequestUserInputBlocks={hideRequestUserInputBlocks}
                hiddenRequestUserInputIds={hiddenRequestUserInputIds}
                onFork={
                  onForkMessage && message.turnId
                    ? () => onForkMessage(message)
                    : undefined
                }
              />
            )}
          </article>
        );
        const gap = renderGapAfterMessage?.(message, nextMessage);
        return virtualMessages ? (
          <div
            key={row.key}
            ref={row.measureRef}
            data-index={index}
            style={row.style}
          >
            {article}
            {gap}
          </div>
        ) : (
          <Fragment key={row.key}>
            {article}
            {gap}
          </Fragment>
        );
      })}
      {shouldShowWaitingIndicator && (
        <article
          className="min-w-0"
          data-testid="message-assistant-waiting"
          style={
            virtualMessages
              ? {
                  position: "absolute",
                  left: 0,
                  top: messageVirtualizer.getTotalSize() + MESSAGE_LIST_GAP_PX,
                  width: "100%",
                }
              : undefined
          }
        >
          <AssistantThinkingIndicator />
        </article>
      )}
    </div>
  );
}, areMessageListPropsEqual);

function getVirtualMeasurementSnapshot(
  key: string | null,
  messages: WorkbenchMessage[],
): VirtualItem[] {
  if (key === null) return [];
  const snapshot = getConversationVirtualMeasurements(key);
  if (!snapshot) return [];

  const messageIds = new Set(messages.map((message) => message.id));
  if (
    snapshot.some(
      (item) => typeof item.key === "string" && !messageIds.has(item.key),
    )
  )
    return [];

  return snapshot;
}

function selectableMessageBodiesForRange(
  root: HTMLElement,
  range: Range,
): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>("[data-message-selectable-text]"),
  ).filter(
    (element) => selectedTextWithinElement(range, element).trim().length > 0,
  );
}

function selectedTextWithinElement(range: Range, element: HTMLElement): string {
  if (!range.intersectsNode(element)) return "";

  const intersection = document.createRange();
  intersection.selectNodeContents(element);
  if (intersection.compareBoundaryPoints(Range.START_TO_START, range) < 0) {
    intersection.setStart(range.startContainer, range.startOffset);
  }
  if (intersection.compareBoundaryPoints(Range.END_TO_END, range) > 0) {
    intersection.setEnd(range.endContainer, range.endOffset);
  }
  return intersection.toString();
}

function isNodeInsideElement(node: Node | null, root: HTMLElement): boolean {
  if (!node) return false;

  if (node.nodeType === Node.ELEMENT_NODE) {
    return root.contains(node);
  }

  return Boolean(node.parentElement && root.contains(node.parentElement));
}

function areMessageListPropsEqual(
  previous: MessageListProps,
  next: MessageListProps,
): boolean {
  const changed = [
    previous.userMessageServices !== next.userMessageServices
      ? "userMessageServices"
      : null,
    previous.virtualize !== next.virtualize ? "virtualize" : null,
    previous.useContentVisibility !== next.useContentVisibility
      ? "useContentVisibility"
      : null,
    previous.onVirtualMeasurement !== next.onVirtualMeasurement
      ? "onVirtualMeasurement"
      : null,
    previous.renderVisualization !== next.renderVisualization
      ? "renderVisualization"
      : null,
    previous.messages !== next.messages ? "messages" : null,
    previous.scrollElementRef !== next.scrollElementRef
      ? "scrollElementRef"
      : null,
    previous.bottomOrigin !== next.bottomOrigin ? "bottomOrigin" : null,
    previous.initialDistanceFromBottomPx !== next.initialDistanceFromBottomPx
      ? "initialDistanceFromBottomPx"
      : null,
    previous.onBeforeUserMessageToggle !== next.onBeforeUserMessageToggle
      ? "onBeforeUserMessageToggle"
      : null,
    previous.onVirtualLayoutChange !== next.onVirtualLayoutChange
      ? "onVirtualLayoutChange"
      : null,
    previous.className !== next.className ? "className" : null,
    previous.conversationKey !== next.conversationKey
      ? "conversationKey"
      : null,
    previous.isWaitingForAssistant !== next.isWaitingForAssistant
      ? "isWaitingForAssistant"
      : null,
    previous.disableContentVisibility !== next.disableContentVisibility
      ? "disableContentVisibility"
      : null,
    previous.forceVirtualMessageId !== next.forceVirtualMessageId
      ? "forceVirtualMessageId"
      : null,
    previous.devices !== next.devices ? "devices" : null,
    previous.onRetryFailedMessage !== next.onRetryFailedMessage
      ? "onRetryFailedMessage"
      : null,
    previous.onSwitchModelForFailedMessage !==
    next.onSwitchModelForFailedMessage
      ? "onSwitchModelForFailedMessage"
      : null,
    previous.onLoadFileChangesDiff !== next.onLoadFileChangesDiff
      ? "onLoadFileChangesDiff"
      : null,
    previous.onRevertFileChanges !== next.onRevertFileChanges
      ? "onRevertFileChanges"
      : null,
    previous.onOpenFileChangesReview !== next.onOpenFileChangesReview
      ? "onOpenFileChangesReview"
      : null,
    previous.fileChangesDiffPreviewDisabledSubtaskId !==
    next.fileChangesDiffPreviewDisabledSubtaskId
      ? "fileChangesDiffPreviewDisabledSubtaskId"
      : null,
    previous.onOpenWorkspaceFile !== next.onOpenWorkspaceFile
      ? "onOpenWorkspaceFile"
      : null,
    previous.onOpenLocalSkillFile !== next.onOpenLocalSkillFile
      ? "onOpenLocalSkillFile"
      : null,
    previous.onRequestUserInputSubmit !== next.onRequestUserInputSubmit
      ? "onRequestUserInputSubmit"
      : null,
    previous.onRequestUserInputIgnore !== next.onRequestUserInputIgnore
      ? "onRequestUserInputIgnore"
      : null,
    previous.onOpenAssistantPlan !== next.onOpenAssistantPlan
      ? "onOpenAssistantPlan"
      : null,
    previous.onOpenSubagent !== next.onOpenSubagent ? "onOpenSubagent" : null,
    previous.onEditLastUserMessage !== next.onEditLastUserMessage
      ? "onEditLastUserMessage"
      : null,
    previous.canEditLastUserMessage !== next.canEditLastUserMessage
      ? "canEditLastUserMessage"
      : null,
    previous.onForkMessage !== next.onForkMessage ? "onForkMessage" : null,
    previous.hideRequestUserInputBlocks !== next.hideRequestUserInputBlocks
      ? "hideRequestUserInputBlocks"
      : null,
    previous.hiddenRequestUserInputIds !== next.hiddenRequestUserInputIds
      ? "hiddenRequestUserInputIds"
      : null,
    previous.onAddSelectionToConversation !== next.onAddSelectionToConversation
      ? "onAddSelectionToConversation"
      : null,
    previous.onAskSelectionInSidebar !== next.onAskSelectionInSidebar
      ? "onAskSelectionInSidebar"
      : null,
    previous.virtualAnchorToEnd !== next.virtualAnchorToEnd
      ? "virtualAnchorToEnd"
      : null,
    previous.renderGapAfterMessage !== next.renderGapAfterMessage
      ? "renderGapAfterMessage"
      : null,
  ].filter((key): key is string => key !== null);

  return changed.length === 0;
}

function shouldRenderMessage(message: WorkbenchMessage): boolean {
  if (message.role !== "assistant") return true;
  if (message.status === "streaming" || message.status === "failed")
    return true;
  if (isCancelledAssistantMessage(message)) return true;
  if (message.fileChanges) return true;
  if (message.references?.length || message.memoryCitations?.length) {
    return true;
  }

  const visibleContent = shouldHideFailedAssistantContent(message)
    ? ""
    : stripPluginWorkspaceResultMarkers(message.content);
  if (visibleContent.trim()) return true;

  return getDisplayProcessingBlocks(message.blocks).length > 0;
}

function editableLastUserMessage(
  messages: WorkbenchMessage[],
  canEdit: boolean,
): WorkbenchMessage | null {
  if (!canEdit) return null;

  const lastUserIndex = findLastIndex(
    messages,
    (message) => message.role === "user",
  );
  if (lastUserIndex === -1) return null;

  const followingMessages = messages.slice(lastUserIndex + 1);
  if (followingMessages.length === 0) return null;
  if (followingMessages.some((message) => message.status === "streaming"))
    return null;
  if (!followingMessages.some((message) => message.role === "assistant"))
    return null;

  return messages[lastUserIndex] ?? null;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return index;
  }
  return -1;
}
