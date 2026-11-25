import type {
  ProcessingBlock,
  RuntimeConversationTurn,
  RuntimeConversationItem,
  WorkbenchMessage,
} from "./runtime-conversation";
export const RUNTIME_RECONNECTING_TOOL_NAME = "runtime_reconnecting";
export function isRuntimeRetryWaitBlock(block: ProcessingBlock): boolean {
  return (
    block.type === "tool" &&
    block.toolName === RUNTIME_RECONNECTING_TOOL_NAME &&
    block.status !== "done" &&
    block.status !== "error"
  );
}
export function isRuntimeRateLimitWaitBlock(block: ProcessingBlock): boolean {
  return (
    isRuntimeRetryWaitBlock(block) &&
    block.type === "tool" &&
    block.toolInput?.retry_reason === "rate_limit"
  );
}
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

export function completeRuntimeTurnTiming(
  turn: RuntimeConversationTurn,
  source: Pick<
    RuntimeConversationTurn,
    "startedAt" | "completedAt" | "durationMs"
  >,
): Pick<RuntimeConversationTurn, "startedAt" | "completedAt" | "durationMs"> {
  const previousEnd = ["done", "failed", "cancelled"].includes(turn.status)
    ? turn.completedAt
    : undefined;
  if (
    previousEnd != null &&
    (source.durationMs ?? 0) <= (turn.durationMs ?? 0)
  ) {
    return {
      startedAt: turn.startedAt ?? source.startedAt,
      completedAt: previousEnd,
      durationMs: turn.durationMs ?? source.durationMs,
    };
  }
  const end = source.completedAt ?? previousEnd;
  const recordedEnd = typeof end === "number" ? end : Date.parse(end ?? "");
  const completedAt = Number.isFinite(recordedEnd) ? recordedEnd : Date.now();
  const startedAt = turn.startedAt ?? source.startedAt;
  const elapsed =
    startedAt === undefined ? undefined : Math.max(0, completedAt - startedAt);
  // Replay can deliver start and completion together. The elapsed time at the
  // renderer may omit work that the executor already measured.
  const durationMs =
    source.durationMs !== undefined
      ? Math.max(source.durationMs, elapsed ?? 0)
      : elapsed;
  return {
    startedAt:
      durationMs !== undefined &&
      (elapsed === undefined || durationMs > elapsed)
        ? completedAt - durationMs
        : startedAt,
    completedAt: new Date(completedAt).toISOString(),
    durationMs,
  };
}
