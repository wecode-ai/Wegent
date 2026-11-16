import {
  nestWorkbenchProcessingBlocks,
  projectWorkbenchSubagentActivity,
  settleWorkbenchProcessingBlock,
} from "@wegent/chat-core";
import type {
  WorkbenchMessage,
  ProcessingBlock,
  RuntimeAssistantDisplayItem,
  RuntimeConversationTurn,
} from "@wegent/chat-core/runtime-conversation";
import type { ConversationSearchSource } from "@wegent/chat-core/conversation-search";
import {
  projectPluginWorkspaceResultText,
  stripPluginWorkspaceResultMarkers,
} from "@wegent/chat-core/plugin-workspace-result";
import {
  isContextCompactionToolName,
  isGuidanceToolName,
} from "./blocks/toolBlockKinds";
import {
  buildProcessingDisplayRows,
  isWebSearchToolName,
} from "./blocks/toolBlockActivity";

export function getTurnStartMs(createdAt: string): number | undefined {
  return getMessageTimestampMs(createdAt);
}

export function getMessageTimestampMs(
  value: string | number | null | undefined,
): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) return value;
    if (value > 1_000_000_000) return value * 1000;
    return undefined;
  }

  if (typeof value !== "string" || !value.trim()) return undefined;
  const numericValue = Number(value);
  if (Number.isFinite(numericValue)) {
    return getMessageTimestampMs(numericValue);
  }

  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

export function formatCompactDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60)
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function getStoppedElapsedDuration(
  message: WorkbenchMessage,
  turn?: RuntimeConversationTurn,
): string | null {
  if (turn?.durationMs !== undefined) {
    return turn.durationMs >= 1000
      ? formatCompactDuration(turn.durationMs)
      : null;
  }
  if (turn) return null;

  const startedAt = getTurnStartMs(message.createdAt);
  if (startedAt === undefined) return null;

  const completedAt = getMessageTimestampMs(message.completedAt);
  if (completedAt !== undefined && completedAt >= startedAt) {
    const durationMs = completedAt - startedAt;
    return durationMs >= 1000 ? formatCompactDuration(durationMs) : null;
  }

  const blockEndTimes =
    message.blocks
      ?.map((block) => block.createdAt)
      .filter((createdAt): createdAt is number => Number.isFinite(createdAt)) ??
    [];
  const endedAt =
    blockEndTimes.length > 0 ? Math.max(...blockEndTimes) : startedAt;

  const durationMs = endedAt - startedAt;
  return durationMs >= 1000 ? formatCompactDuration(durationMs) : null;
}

export function getProcessingSummaryStartMs(
  message: WorkbenchMessage,
  blocks: ProcessingBlock[],
  isStreaming: boolean,
): number | undefined {
  const turnStartedAt = getTurnStartMs(message.createdAt);
  const blockStartTimes = blocks
    .map((block) => block.createdAt)
    .filter((createdAt): createdAt is number => Number.isFinite(createdAt));
  const earliestBlockStart =
    blockStartTimes.length > 0 ? Math.min(...blockStartTimes) : undefined;

  if (blocks.length > 0) return earliestBlockStart ?? turnStartedAt;
  if (!isStreaming) return turnStartedAt;

  return undefined;
}

export function isCancelledAssistantMessage(
  message: WorkbenchMessage,
): boolean {
  return message.runtimeStatus === "cancelled";
}

function isCancelledPlaceholderContent(content: string): boolean {
  return ["interrupted", "cancelled", "canceled", "aborted"].includes(
    content.trim().toLowerCase(),
  );
}

const RAW_FAILED_MESSAGE_PATTERNS = [
  /^api error:/i,
  /^task failed/i,
  /^error:/i,
  /"error"\s*:/i,
  /"error_(type|code)"\s*:/i,
  /\b(status|type)\s*:\s*failed\b/i,
];

export function shouldHideFailedAssistantContent(message: WorkbenchMessage) {
  if (message.status !== "failed" || !message.error) return false;

  const content = message.content.trim();
  const error = message.error.trim();
  if (!content) return false;
  if (content === error) return true;

  return RAW_FAILED_MESSAGE_PATTERNS.some((pattern) => pattern.test(content));
}

/** Applies the same prose visibility rules to rendering and search projection. */
export function getAssistantContentPresentation(message: WorkbenchMessage): {
  content: string;
  hidden: boolean;
} {
  const hidden =
    shouldHideFailedAssistantContent(message) ||
    (isCancelledAssistantMessage(message) &&
      isCancelledPlaceholderContent(message.content));
  return {
    content: hidden ? "" : stripPluginWorkspaceResultMarkers(message.content),
    hidden,
  };
}

export function getDisplayProcessingBlocks(
  blocks: ProcessingBlock[] | undefined,
  settleForCancelledTurn = false,
  finalContent = "",
): ProcessingBlock[] {
  if (!blocks?.length) return [];

  return nestWorkbenchProcessingBlocks(
    projectWorkbenchSubagentActivity(
      blocks
        .map((block) =>
          settleForCancelledTurn
            ? settleWorkbenchProcessingBlock(block)
            : block,
        )
        .filter((block) => {
          if (block.type === "thinking") return false;
          if (block.type !== "text") return true;

          const content = block.content.trim();
          return Boolean(content) && content !== finalContent.trim();
        }),
    ),
  );
}

export function getWebSearchToolBlocks(blocks: ProcessingBlock[]) {
  return blocks.filter(
    (block): block is Extract<ProcessingBlock, { type: "tool" }> =>
      block.type === "tool" && isWebSearchToolName(block.toolName),
  );
}

export interface AssistantProseRegion {
  id: string;
  content: string;
  sources: ConversationSearchSource[];
}

/** This is the renderer's prose layout, including the sources used by its index. */
export function getAssistantRenderProjection(message: WorkbenchMessage) {
  const presentation = getAssistantContentPresentation(message);
  const blocks = getDisplayProcessingBlocks(
    message.blocks,
    isCancelledAssistantMessage(message),
    presentation.content,
  );
  const ordered = getOrderedRuntimeDisplaySegments(
    message.runtimeDisplayItems,
    blocks,
  );
  const contentSegments = ordered.filter(
    (segment) => segment.kind === "content",
  );
  const orderedContent = contentSegments
    .map((segment) => segment.content)
    .join("\n\n");
  const interleaved =
    Boolean(presentation.content.trim()) &&
    orderedContent === presentation.content &&
    ordered.some(
      (segment, index) =>
        segment.kind === "content" &&
        ordered.slice(index + 1).some((next) => next.kind === "processing"),
    );
  const firstItem = message.runtimeDisplayItems?.find(
    (item) => item.type === "assistant_text",
  );
  const finalRegion: AssistantProseRegion = {
    id: firstItem?.id ?? message.id,
    content: presentation.content,
    sources: [],
  };
  if (!firstItem && presentation.content) {
    finalRegion.sources = projectPluginWorkspaceResultText(
      message.content,
    ).sources.map((source) => ({ ...source, itemId: message.id }));
  } else {
    let cursor = 0;
    for (const segment of contentSegments) {
      const offset = presentation.content.indexOf(segment.content, cursor);
      if (offset < 0) continue;
      finalRegion.sources.push(
        ...segment.sources.map((source) => ({
          ...source,
          start: source.start + offset,
          end: source.end + offset,
        })),
      );
      cursor = offset + segment.content.length;
    }
  }
  const segments: RuntimeDisplaySegment[] = interleaved
    ? ordered
    : [
        ...(blocks.length
          ? [{ id: blocks[0].id, kind: "processing" as const, blocks }]
          : []),
        ...(presentation.content
          ? [{ kind: "content" as const, ...finalRegion }]
          : []),
      ];
  const regions = segments.flatMap<AssistantProseRegion>((segment) =>
    segment.kind === "content"
      ? [segment]
      : segment.blocks.flatMap((block) =>
          block.type === "text"
            ? [
                {
                  id: block.id,
                  content: block.content,
                  sources: [
                    {
                      itemId: block.id,
                      start: 0,
                      end: block.content.length,
                      sourceStart: 0,
                      sourceEnd: block.content.length,
                    },
                  ],
                },
              ]
            : [],
        ),
  );
  return {
    ...presentation,
    blocks,
    segments,
    regions,
    interleaved,
    finalRegion,
  };
}

export function getMessageDisplayStateKey(
  conversationKey: string | number | null | undefined,
  message: WorkbenchMessage,
): string {
  const conversationPart =
    conversationKey == null ? "default" : String(conversationKey);
  return `${conversationPart}:${message.id}`;
}

export function hasRunningProcessingBlocks(blocks: ProcessingBlock[]): boolean {
  return blocks.some(
    (block) => block.status !== "done" && block.status !== "error",
  );
}

type ProcessingSegment = {
  kind: "tool" | "narrative";
  blocks: ProcessingBlock[];
};

export type RuntimeDisplaySegment =
  | {
      id: string;
      kind: "content";
      content: string;
      sources: ConversationSearchSource[];
    }
  | {
      id: string;
      kind: "processing";
      blocks: ProcessingBlock[];
    };

export function getOrderedRuntimeDisplaySegments(
  items: RuntimeAssistantDisplayItem[] | undefined,
  displayBlocks: ProcessingBlock[],
): RuntimeDisplaySegment[] {
  if (!items?.length) return [];

  const blocksById = new Map(displayBlocks.map((block) => [block.id, block]));
  const subagentsByAnchorId = new Map(
    displayBlocks.flatMap((block) =>
      block.type === "subagent" && block.anchorBlockId
        ? [[block.anchorBlockId, block] as const]
        : [],
    ),
  );
  const renderedAnchoredSubagentIds = new Set<string>();
  const segments: RuntimeDisplaySegment[] = [];

  items.forEach((item) => {
    if (item.type === "assistant_text") {
      const projection = projectPluginWorkspaceResultText(item.content);
      const content = projection.content;
      if (!content.trim()) return;
      const previous = segments.at(-1);
      if (previous?.kind === "content") {
        const start = previous.content.length + 2;
        previous.sources.push(
          ...projection.sources.map((source) => ({
            ...source,
            itemId: item.id,
            start: source.start + start,
            end: source.end + start,
          })),
        );
        previous.content = `${previous.content}\n\n${content}`;
      } else {
        segments.push({
          kind: "content",
          id: item.id,
          content,
          sources: projection.sources.map((source) => ({
            ...source,
            itemId: item.id,
          })),
        });
      }
      return;
    }

    const block = subagentsByAnchorId.get(item.id) ?? blocksById.get(item.id);
    if (!block) return;
    if (block.type === "subagent" && block.anchorBlockId) {
      if (renderedAnchoredSubagentIds.has(block.id)) return;
      renderedAnchoredSubagentIds.add(block.id);
    }
    const previous = segments.at(-1);
    if (previous?.kind === "processing") {
      previous.blocks.push(block);
    } else {
      segments.push({ id: item.id, kind: "processing", blocks: [block] });
    }
  });

  return segments;
}

export function getProcessingPhase(
  segments: ProcessingSegment[],
  index: number,
  hasFinalContent: boolean,
): "live" | "intermediate" | "final" {
  const laterSegments = segments.slice(index + 1);
  if (
    hasFinalContent &&
    !laterSegments.some((segment) => segment.kind === "tool")
  )
    return "final";
  if (laterSegments.some((segment) => segment.kind === "narrative"))
    return "intermediate";
  return "live";
}

export function splitProcessingBlocks(
  blocks: ProcessingBlock[],
): ProcessingSegment[] {
  if (blocks.length === 0) return [{ kind: "tool", blocks: [] }];

  const segments: ProcessingSegment[] = [];

  blocks.forEach((block) => {
    const kind = isCollapsibleToolBlock(block) ? "tool" : "narrative";
    const previous = segments.at(-1);
    if (previous?.kind === kind) {
      previous.blocks.push(block);
      return;
    }
    segments.push({ kind, blocks: [block] });
  });

  return segments;
}

export function isCollapsibleToolBlock(block: ProcessingBlock): boolean {
  if (block.type === "file_changes") return true;
  if (block.type !== "tool") return false;
  return (
    !isGuidanceToolName(block.toolName) &&
    !isContextCompactionToolName(block.toolName)
  );
}

export function shouldShowAssistantThinkingIndicator({
  isStreaming,
  blocks,
  hasVisibleContent,
}: {
  isStreaming: boolean;
  blocks: ProcessingBlock[];
  hasVisibleContent: boolean;
}): boolean {
  // Completed guidance has no live indicator of its own.
  const pendingBlocks = blocks.filter(
    (block) =>
      block.type !== "tool" ||
      !isGuidanceToolName(block.toolName) ||
      (block.status !== "done" && block.status !== "error"),
  );
  const lastBlock = pendingBlocks.at(-1);
  const hasTrailingCompletedText =
    lastBlock?.type === "text" &&
    (lastBlock.status === "done" || lastBlock.status === "error");
  return (
    isStreaming &&
    !hasVisibleContent &&
    (buildProcessingDisplayRows(pendingBlocks).length === 0 ||
      hasTrailingCompletedText)
  );
}
