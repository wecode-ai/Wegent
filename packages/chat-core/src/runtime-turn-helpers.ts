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
export function assistantTextContent(items: RuntimeConversationItem[]): string {
  return items
    .flatMap((item) => (item.type === "assistant_text" ? [item.content] : []))
    .join("\n\n");
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
