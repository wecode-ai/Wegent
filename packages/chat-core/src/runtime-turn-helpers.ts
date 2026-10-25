import { getLatestThinkingContent } from "./workbench-message-reducer";

import type {
  ProcessingBlock,
  RuntimeConversationTurn,
  RuntimeConversationItem,
  WorkbenchMessage,
} from "./runtime-conversation";
export const RUNTIME_RECONNECTING_TOOL_NAME = "runtime_reconnecting";
export const MAX_VISIBLE_RUNTIME_PROCESSING_BLOCKS = 256;
export function processingBlocks(
  items: RuntimeConversationItem[],
): ProcessingBlock[] {
  return items.flatMap((item) => (item.type === "block" ? [item.block] : []));
}
export function resolveRuntimeTurnThinkingContent({
  items,
  status,
}: Pick<RuntimeConversationTurn, "items" | "status">): string | undefined {
  if (status !== "streaming") return undefined;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type === "assistant_text" && item.content) return undefined;
    if (item.type !== "block") continue;
    if (item.block.type === "text" || item.block.type === "plan")
      return undefined;
    if (item.block.type === "thinking" || item.block.type === "tool") {
      return getLatestThinkingContent(processingBlocks(items));
    }
  }
  return undefined;
}
export function preserveProcessingBlockTiming(
  previous: ProcessingBlock,
  next: ProcessingBlock,
): ProcessingBlock {
  const previousComplete =
    previous.status === "done" || previous.status === "error";
  const nextComplete = next.status === "done" || next.status === "error";
  const createdAt = previousComplete ? next.createdAt : previous.createdAt;
  if (previousComplete && nextComplete && previous.completedAt !== undefined) {
    if (next.completedAt === undefined) {
      return {
        ...next,
        createdAt: previous.createdAt,
        completedAt: previous.completedAt,
        durationMs: next.durationMs ?? previous.durationMs,
      } as ProcessingBlock;
    }
  }
  if (createdAt === next.createdAt) return next;
  return {
    ...next,
    createdAt,
    ...(nextComplete &&
      next.durationMs !== undefined && {
        completedAt: createdAt + next.durationMs,
      }),
  } as ProcessingBlock;
}
export function turnStatus(
  turn: RuntimeConversationTurn,
): WorkbenchMessage["status"] {
  if (turn.status === "cancelled") return "done";
  return turn.status;
}

/** Live completion closes the same wall-clock interval used by the running label. */
export function completeRuntimeTurnTiming(
  turn: RuntimeConversationTurn,
  source: { startedAt?: number; durationMs?: number },
): Pick<RuntimeConversationTurn, "startedAt" | "completedAt" | "durationMs"> {
  if (
    ["done", "failed", "cancelled"].includes(turn.status) &&
    turn.completedAt !== null &&
    turn.completedAt !== undefined
  ) {
    return {
      startedAt: turn.startedAt ?? source.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs ?? source.durationMs,
    };
  }
  const completedAt = Date.now();
  return {
    startedAt: turn.startedAt ?? source.startedAt,
    completedAt: new Date(completedAt).toISOString(),
    durationMs:
      turn.startedAt === undefined
        ? source.durationMs
        : Math.max(0, completedAt - turn.startedAt),
  };
}
