import {
  nestWorkbenchProcessingBlocks,
  projectWorkbenchSubagentActivity,
} from "@wegent/chat-core";
import type {
  WorkbenchMessage,
  ProcessingBlock,
  RuntimeAssistantDisplayItem,
  RuntimeConversationTurn,
} from "@wegent/chat-core/runtime-conversation";
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

export function isCancelledPlaceholderContent(content: string): boolean {
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
          settleForCancelledTurn &&
          block.status !== "done" &&
          block.status !== "error"
            ? { ...block, status: "done" as const }
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

type RuntimeDisplaySegment =
  | {
      kind: "content";
      content: string;
    }
  | {
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
      if (!item.content.trim()) return;
      const previous = segments.at(-1);
      if (previous?.kind === "content") {
        previous.content = `${previous.content}\n\n${item.content}`;
      } else {
        segments.push({ kind: "content", content: item.content });
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
      segments.push({ kind: "processing", blocks: [block] });
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

export function hasProcessingDisplayBlock(blocks: ProcessingBlock[]): boolean {
  return buildProcessingDisplayRows(blocks).length > 0;
}

export function hasTrailingCompletedProcessText(
  blocks: ProcessingBlock[],
): boolean {
  const lastBlock = blocks.at(-1);
  return (
    lastBlock?.type === "text" &&
    (lastBlock.status === "done" || lastBlock.status === "error")
  );
}

export function shouldShowAssistantThinkingIndicator({
  isStreaming,
  hasProcessingDisplayBlock,
  hasVisibleContent,
  hasTrailingCompletedProcessText,
}: {
  isStreaming: boolean;
  hasProcessingDisplayBlock: boolean;
  hasVisibleContent: boolean;
  hasTrailingCompletedProcessText: boolean;
}): boolean {
  return (
    isStreaming &&
    !hasVisibleContent &&
    (!hasProcessingDisplayBlock || hasTrailingCompletedProcessText)
  );
}
