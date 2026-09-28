import type { RefObject } from "react";
import type { RuntimeTurnNavigationItem } from "@wegent/chat-core/runtime";
import { visibleRuntimeUserMessage } from "@wegent/chat-core/runtime-user-message";
import {
  USER_PREVIEW_LENGTH,
  RESPONSE_PREVIEW_LENGTH,
  SCROLL_OFFSET_PX,
  COLLAPSED_MARKER_WIDTH_PX,
  SECONDARY_MARKER_WIDTH_PX,
  NEARBY_MARKER_WIDTH_PX,
  EXPANDED_MARKER_WIDTH_PX,
  MARKER_ROW_HEIGHT_PX,
  MARKER_ROW_GAP_PX,
  MESSAGE_ANCHOR_SELECTOR,
} from "./turnNavigationConstants";
import type {
  UserTurn,
  MessageTurnMarker,
  PendingScrollTarget,
  TurnVisibilityBounds,
  NavigationMessage,
} from "./turnNavigationTypes";
import {
  getContentPositionForViewportY,
  getDistanceFromBottom,
  hasBottomScrollOrigin,
  scrollToContentPosition,
} from "./bottomOriginScroll";
export function buildUserTurnsForNavigation(
  messages: NavigationMessage[],
  navigation?: RuntimeTurnNavigationItem[],
): UserTurn[] {
  const messageTurns = buildUserTurns(messages);
  if (navigation === undefined) return messageTurns;
  if (navigation.length === 0) return [];

  const navigationTurns = buildUserTurnsFromNavigation(navigation, messages);
  return navigationTurns.length >= messageTurns.length
    ? navigationTurns
    : messageTurns;
}

export function getUserTurnsSignature(turns: UserTurn[]) {
  return JSON.stringify(turns);
}

function buildUserTurns(messages: NavigationMessage[]): UserTurn[] {
  const turns: UserTurn[] = [];
  const pendingResponsePreviewTurnIndexes: number[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "user") {
      if (
        message.role === "assistant" &&
        pendingResponsePreviewTurnIndexes.length > 0
      ) {
        const responsePreview = getAssistantPreview(message);
        pendingResponsePreviewTurnIndexes.forEach((turnIndex) => {
          turns[turnIndex].responsePreview = responsePreview;
        });
        pendingResponsePreviewTurnIndexes.length = 0;
      }
      return;
    }

    turns.push({
      id: message.id,
      turnId: message.turnId,
      turnIndex: turns.length,
      messageIndex:
        typeof message.runtimeMessageIndex === "number"
          ? message.runtimeMessageIndex
          : index,
      promptPreview: getUserPromptPreview(message),
      responsePreview: "",
      cursor: null,
      loaded: true,
    });
    pendingResponsePreviewTurnIndexes.push(turns.length - 1);
  });

  return turns;
}

function buildUserTurnsFromNavigation(
  navigation: RuntimeTurnNavigationItem[],
  messages: NavigationMessage[],
): UserTurn[] {
  const loadedTurns = buildUserTurns(messages);
  const loadedTurnsByIndex = new Map(
    loadedTurns.map((turn) => [turn.messageIndex, turn]),
  );
  const loadedTurnsById = new Map(loadedTurns.map((turn) => [turn.id, turn]));
  const loadedTurnsByTurnId = new Map(
    loadedTurns.flatMap((turn) =>
      turn.turnId ? [[turn.turnId, turn] as const] : [],
    ),
  );
  const uniqueNavigation = deduplicateNavigationItems(
    navigation,
    loadedTurnsByIndex,
  );

  const navigationTurns = uniqueNavigation.map((item, index) => {
    const loadedTurn =
      (item.turnId ? loadedTurnsByTurnId.get(item.turnId) : undefined) ??
      loadedTurnsByIndex.get(item.messageIndex) ??
      loadedTurnsById.get(item.id);
    return {
      id: loadedTurn?.id ?? item.id,
      turnId: item.turnId ?? loadedTurn?.turnId,
      turnIndex: typeof item.turnIndex === "number" ? item.turnIndex : index,
      messageIndex: loadedTurn?.messageIndex ?? item.messageIndex,
      promptPreview: loadedTurn?.promptPreview ?? item.promptPreview,
      responsePreview:
        loadedTurn?.responsePreview || item.responsePreview || "",
      cursor: item.cursor ?? null,
      loaded: Boolean(loadedTurn),
    };
  });
  const navigationMessageIds = new Set(navigationTurns.map((turn) => turn.id));

  return [
    ...navigationTurns,
    ...loadedTurns.filter((turn) => !navigationMessageIds.has(turn.id)),
  ]
    .sort((left, right) => left.messageIndex - right.messageIndex)
    .map((turn, turnIndex) => ({ ...turn, turnIndex }));
}

function deduplicateNavigationItems(
  navigation: RuntimeTurnNavigationItem[],
  loadedTurnsByIndex: ReadonlyMap<number, UserTurn>,
): RuntimeTurnNavigationItem[] {
  const uniqueItems = new Map<string, RuntimeTurnNavigationItem>();

  navigation.forEach((item) => {
    const current = uniqueItems.get(item.id);
    if (!current) {
      uniqueItems.set(item.id, item);
      return;
    }

    const currentIsLoaded = loadedTurnsByIndex.has(current.messageIndex);
    const itemIsLoaded = loadedTurnsByIndex.has(item.messageIndex);
    if (!currentIsLoaded && itemIsLoaded) {
      uniqueItems.set(item.id, item);
    }
  });

  return Array.from(uniqueItems.values());
}

function getUserPromptPreview(message: NavigationMessage) {
  return truncatePreview(
    visibleRuntimeUserMessage(message.content),
    USER_PREVIEW_LENGTH,
  );
}

function getAssistantPreview(message: NavigationMessage) {
  const textBlockContent = getFirstTextBlockContent(message);
  const previewSource = message.content.trim() || textBlockContent;
  return truncatePreview(previewSource, RESPONSE_PREVIEW_LENGTH);
}

function getFirstTextBlockContent(message: NavigationMessage) {
  for (const block of message.blocks ?? []) {
    if (
      block.type !== "text" ||
      !("content" in block) ||
      typeof block.content !== "string"
    ) {
      continue;
    }

    if (block.content.trim()) {
      return block.content;
    }
  }

  return "";
}

function truncatePreview(text: string, maxLength: number) {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (normalizedText.length <= maxLength) return normalizedText;

  return `${normalizedText.slice(0, maxLength)}...`;
}

export function getNavigationHeight(markerCount: number) {
  if (markerCount <= 1) return MARKER_ROW_HEIGHT_PX;

  return (
    MARKER_ROW_HEIGHT_PX +
    (markerCount - 1) * (MARKER_ROW_HEIGHT_PX + MARKER_ROW_GAP_PX)
  );
}

export function getMarkerTopPx(index: number) {
  return (
    MARKER_ROW_HEIGHT_PX / 2 +
    index * (MARKER_ROW_HEIGHT_PX + MARKER_ROW_GAP_PX)
  );
}

export function getMarkerWidthPx(
  hoverDistance: number | null,
  loading = false,
) {
  if (loading) return EXPANDED_MARKER_WIDTH_PX;
  if (hoverDistance === 0) return EXPANDED_MARKER_WIDTH_PX;
  if (hoverDistance === 1) return NEARBY_MARKER_WIDTH_PX;
  if (hoverDistance === 2) return SECONDARY_MARKER_WIDTH_PX;

  return COLLAPSED_MARKER_WIDTH_PX;
}

export function findUnloadedMarkerBetween(
  markers: MessageTurnMarker[],
  activeMarkerId: string | null,
  targetMarkerId: string,
): MessageTurnMarker | null {
  if (!activeMarkerId || activeMarkerId === targetMarkerId) return null;

  const activeIndex = markers.findIndex(
    (marker) => marker.id === activeMarkerId,
  );
  const targetIndex = markers.findIndex(
    (marker) => marker.id === targetMarkerId,
  );
  if (activeIndex === -1 || targetIndex === -1) return null;

  const start = Math.min(activeIndex, targetIndex) + 1;
  const end = Math.max(activeIndex, targetIndex);
  const candidates = markers
    .slice(start, end)
    .filter((marker) => !marker.loaded);
  if (candidates.length === 0) return null;

  return targetIndex > activeIndex
    ? candidates[0]
    : candidates[candidates.length - 1];
}

export function getMarkerToneClass(
  isActive: boolean,
  hoverDistance: number | null,
  loaded: boolean,
  loading = false,
) {
  if (loading) return "animate-pulse bg-primary opacity-100";
  if (hoverDistance === 0) return "bg-text-primary opacity-100";
  if (hoverDistance === 1) return "bg-text-primary/70 opacity-90";
  if (hoverDistance === 2) return "bg-text-muted/75 opacity-80";
  if (hoverDistance !== null) return "bg-text-muted/55 opacity-70";
  if (isActive) return "bg-text-primary opacity-100";
  if (!loaded) return "bg-text-muted/35 opacity-60";

  return "bg-text-muted/55 opacity-70";
}

export function scrollToMarkerTarget(
  scroller: HTMLDivElement,
  targetTop: number,
  behavior: ScrollBehavior,
) {
  const top = Math.max(0, targetTop - SCROLL_OFFSET_PX);
  scrollToContentPosition(scroller, top, behavior);
}

export function scrollToMessageAnchor(
  scroller: HTMLDivElement,
  anchor: HTMLElement,
  behavior: ScrollBehavior = "auto",
) {
  if (behavior === "smooth") {
    scrollToMarkerTarget(
      scroller,
      getMessageAnchorTargetTop(scroller, anchor),
      behavior,
    );
    return;
  }

  scrollToMarkerTarget(
    scroller,
    getMessageAnchorTargetTop(scroller, anchor),
    "auto",
  );
}

export function findMessageAnchor(
  contentRef: RefObject<HTMLDivElement | null>,
  messageId: string,
): HTMLElement | null {
  const content = contentRef.current;
  return content
    ? (getMessageAnchorById(content).get(messageId) ?? null)
    : null;
}

export function findLoadedNavigationMessageId(
  messages: NavigationMessage[],
  target: PendingScrollTarget,
): string | null {
  if (target.turnId) {
    const turnMessage = messages.find(
      (message) => message.role === "user" && message.turnId === target.turnId,
    );
    if (turnMessage) return turnMessage.id;
  }

  const indexedMessage = messages.find(
    (message) =>
      message.role === "user" &&
      message.runtimeMessageIndex === target.messageIndex,
  );
  if (indexedMessage) return indexedMessage.id;

  return messages.some((message) => message.id === target.navigationId)
    ? target.navigationId
    : null;
}

export function getMessageAnchorTargetTop(
  scroller: HTMLDivElement,
  anchor: HTMLElement,
) {
  const anchorRect = anchor.getBoundingClientRect();
  return getContentPositionForViewportY(scroller, anchorRect.top);
}

export function getScrollMetrics(
  scroller: HTMLElement,
  anchor?: HTMLElement | null,
) {
  const scrollerRect = scroller.getBoundingClientRect();
  const anchorRect = anchor?.getBoundingClientRect();
  return {
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    distanceFromBottom: getDistanceFromBottom(
      scroller,
      hasBottomScrollOrigin(scroller),
    ),
    scrollerTop: scrollerRect.top,
    anchorTop: anchorRect?.top ?? null,
    anchorHeight: anchorRect?.height ?? null,
    anchorOffsetFromScroller: anchorRect
      ? anchorRect.top - scrollerRect.top
      : null,
  };
}

export function logTurnNavigation(
  event: string,
  details: Record<string, unknown>,
) {
  console.warn(`[Wework] Message turn navigation ${event}`, details);
}

export function getMessageAnchorById(content: HTMLElement) {
  const anchors = new Map<string, HTMLElement>();
  content
    .querySelectorAll<HTMLElement>(MESSAGE_ANCHOR_SELECTOR)
    .forEach((anchor) => {
      const messageId = anchor.dataset.messageId;
      if (messageId) {
        anchors.set(messageId, anchor);
      }
    });
  return anchors;
}

export function getTurnVisibilityBounds(
  turns: UserTurn[],
  messages: NavigationMessage[],
  anchorByMessageId: ReadonlyMap<string, HTMLElement>,
  scroller: HTMLDivElement,
): Map<string, TurnVisibilityBounds> {
  const boundsByTurnId = new Map<string, TurnVisibilityBounds>();
  const messagePositionById = buildMessageTimelinePositions(messages);

  anchorByMessageId.forEach((anchor, messageId) => {
    const messagePosition = messagePositionById.get(messageId);
    if (messagePosition === undefined) return;
    const turn = findTurnForMessagePosition(turns, messagePosition);
    if (!turn) return;

    const anchorRect = anchor.getBoundingClientRect();
    const top = getContentPositionForViewportY(scroller, anchorRect.top);
    const bottom = getContentPositionForViewportY(scroller, anchorRect.bottom);
    const current = boundsByTurnId.get(turn.id);
    boundsByTurnId.set(turn.id, {
      top: current ? Math.min(current.top, top) : top,
      bottom: current ? Math.max(current.bottom, bottom) : bottom,
    });
  });

  return boundsByTurnId;
}

function buildMessageTimelinePositions(
  messages: NavigationMessage[],
): Map<string, number> {
  const positions = messages.map((message) =>
    Number.isFinite(message.runtimeMessageIndex)
      ? (message.runtimeMessageIndex as number)
      : null,
  );
  if (positions.every((position) => position === null)) {
    return new Map(messages.map((message, index) => [message.id, index]));
  }

  let segmentStart = 0;
  while (segmentStart < positions.length) {
    if (positions[segmentStart] !== null) {
      segmentStart += 1;
      continue;
    }

    let segmentEnd = segmentStart + 1;
    while (segmentEnd < positions.length && positions[segmentEnd] === null) {
      segmentEnd += 1;
    }
    const previousPosition =
      segmentStart > 0 ? positions[segmentStart - 1] : null;
    const nextPosition =
      segmentEnd < positions.length ? positions[segmentEnd] : null;
    const segmentLength = segmentEnd - segmentStart;

    for (let offset = 0; offset < segmentLength; offset += 1) {
      if (previousPosition !== null && nextPosition !== null) {
        positions[segmentStart + offset] =
          previousPosition +
          ((nextPosition - previousPosition) * (offset + 1)) /
            (segmentLength + 1);
      } else if (previousPosition !== null) {
        positions[segmentStart + offset] =
          previousPosition + (offset + 1) / (segmentLength + 1);
      } else if (nextPosition !== null) {
        positions[segmentStart + offset] =
          nextPosition - (segmentLength - offset) / (segmentLength + 1);
      }
    }
    segmentStart = segmentEnd;
  }

  return new Map(
    messages.flatMap((message, index) => {
      const position = positions[index];
      return position === null ? [] : [[message.id, position] as const];
    }),
  );
}

function findTurnForMessagePosition(
  turns: UserTurn[],
  messagePosition: number,
): UserTurn | null {
  let currentTurn: UserTurn | null = null;
  for (const turn of turns) {
    if (turn.messageIndex > messagePosition) break;
    currentTurn = turn;
  }
  return currentTurn;
}

export function equalStringArrays(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function finishNavigationLoad(
  onNavigationLoadStateChange?: (loading: boolean) => void,
) {
  if (!onNavigationLoadStateChange) return;

  if (typeof queueMicrotask === "function") {
    queueMicrotask(() => onNavigationLoadStateChange(false));
    return;
  }

  void Promise.resolve().then(() => onNavigationLoadStateChange(false));
}
