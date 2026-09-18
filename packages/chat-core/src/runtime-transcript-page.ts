import type {
  RuntimeName,
  RuntimeContextUsage,
  RuntimeTurnNavigationItem,
  RuntimeTranscriptResponse,
} from "./runtime";
import type {
  WorkbenchMessage,
  RuntimeConversationTurn,
} from "./runtime-conversation";
import {
  runtimeMessagesToWorkbenchMessages,
  runtimeTranscriptTurnsToConversationTurns,
} from "./runtime-transcript";
export interface LoadedTranscriptRange {
  start: number;
  end: number;
}
export interface RuntimePaneTranscript {
  historyUnavailable?: boolean;
  runtime?: RuntimeName;
  messages: WorkbenchMessage[];
  turns: RuntimeConversationTurn[];
  running?: boolean;
  contextUsage?: RuntimeContextUsage | null;
  turnNavigation?: RuntimeTurnNavigationItem[];
  fullContent?: boolean;
  rangeStart?: number | null;
  rangeEnd?: number | null;
  hasMoreBefore?: boolean;
  beforeCursor?: string | null;
  hasMoreAfter?: boolean;
  afterCursor?: string | null;
}

export function projectRuntimePaneTranscript(
  transcript: RuntimeTranscriptResponse,
): RuntimePaneTranscript {
  return {
    historyUnavailable: transcript.historyUnavailable,
    runtime: transcript.runtime,
    running: transcript.running,
    messages: runtimeMessagesToWorkbenchMessages(transcript.messages ?? []),
    turns: runtimeTranscriptTurnsToConversationTurns(transcript.turns ?? []),
    contextUsage: transcript.contextUsage ?? null,
    turnNavigation: transcript.turnNavigation ?? [],
    fullContent: transcript.fullContent === true,
    rangeStart: transcript.rangeStart ?? null,
    rangeEnd: transcript.rangeEnd ?? null,
    hasMoreBefore: Boolean(transcript.hasMoreBefore),
    beforeCursor: transcript.beforeCursor ?? null,
    hasMoreAfter: Boolean(transcript.hasMoreAfter),
    afterCursor: transcript.afterCursor ?? null,
  };
}

export function transcriptRangeFromPage(
  transcript: RuntimePaneTranscript,
): LoadedTranscriptRange[] {
  const indexedRange = transcriptRangeFromMessageIndexes(transcript.messages);
  const rangeStart =
    numericValue(transcript.rangeStart) ??
    cursorOffset(transcript.beforeCursor) ??
    indexedRange?.start ??
    (transcript.hasMoreBefore ? null : 0);
  const rangeEnd =
    numericValue(transcript.rangeEnd) ??
    cursorOffset(transcript.afterCursor) ??
    indexedRange?.end ??
    (rangeStart === null ? null : rangeStart + transcript.messages.length);

  if (rangeStart === null || rangeEnd === null || rangeEnd < rangeStart)
    return [];
  return [{ start: rangeStart, end: rangeEnd }];
}

export function transcriptRangeFromMessageIndexes(
  messages: WorkbenchMessage[],
): LoadedTranscriptRange | null {
  const indexes = messages
    .map((message) =>
      typeof message.runtimeMessageIndex === "number" &&
      Number.isFinite(message.runtimeMessageIndex)
        ? message.runtimeMessageIndex
        : null,
    )
    .filter((index): index is number => index !== null);
  if (indexes.length === 0) return null;
  return {
    start: Math.min(...indexes),
    end: Math.max(...indexes) + 1,
  };
}

export function mergeTranscriptRanges(
  currentRanges: LoadedTranscriptRange[],
  incomingRanges: LoadedTranscriptRange[],
): LoadedTranscriptRange[] {
  const ranges = [...currentRanges, ...incomingRanges]
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);

  const merged: LoadedTranscriptRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
      continue;
    }
    previous.end = Math.max(previous.end, range.end);
  }
  return merged;
}

export function numericValue(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function cursorOffset(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  const match = /^offset:(\d+)$/.exec(cursor.trim());
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

export function runtimeTurnNavigationLoadOptions(
  item: RuntimeTurnNavigationItem,
  loadedRanges: LoadedTranscriptRange[],
  pageSize: number,
) {
  if (item.cursor && !item.cursor.startsWith("offset:")) {
    return {
      limit: pageSize,
      beforeCursor: item.cursor,
    };
  }

  const messageIndex = Number.isFinite(item.messageIndex)
    ? Math.max(0, item.messageIndex)
    : 0;
  const sortedRanges = mergeTranscriptRanges(loadedRanges, []);
  const nextLoadedRange = sortedRanges.find(
    (range) => range.start > messageIndex,
  );
  const pageEnd = Math.max(
    messageIndex + 1,
    Math.min(
      nextLoadedRange?.start ?? messageIndex + pageSize,
      messageIndex + pageSize,
    ),
  );

  return {
    limit: pageSize,
    beforeCursor: `offset:${pageEnd}`,
  };
}
