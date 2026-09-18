import {
  RUNTIME_RECONNECTING_TOOL_NAME,
  MAX_VISIBLE_RUNTIME_PROCESSING_BLOCKS,
  processingBlocks,
  preserveProcessingBlockTiming,
} from "./runtime-turn-helpers";
import type { RuntimePaneMessageAction } from "./runtime-conversation";

import type { TurnFileChangesSummary } from "./runtime";
import {
  limitWorkbenchProcessingBlock,
  resolveStreamingThinkingContent,
} from "./workbench-message-reducer";

import type {
  ProcessingBlock,
  RuntimeConversationItem,
  RuntimeConversationTurn,
  WorkbenchMessage,
} from "./runtime-conversation";

export function seedRuntimeConversationTurns(
  messages: WorkbenchMessage[],
  currentTurns: RuntimeConversationTurn[],
): RuntimeConversationTurn[] {
  let turns = currentTurns;
  for (const message of messages) {
    if (message.role !== "user") continue;
    const existing = turns.some((turn) =>
      turn.items.some(
        (item) => item.type === "user_message" && item.id === message.id,
      ),
    );
    if (!existing) {
      turns = appendOptimisticUser(turns, message);
    }
  }
  return turns;
}

export function appendAcceptedRuntimeConversationUser(
  turns: RuntimeConversationTurn[],
  message: WorkbenchMessage,
  activeTurnId: string | null,
  turnIdsBeforeSend: ReadonlySet<string>,
): RuntimeConversationTurn[] {
  if (message.role !== "user") return appendOptimisticUser(turns, message);
  if (
    turns.some((turn) =>
      turn.items.some(
        (item) => item.type === "user_message" && item.id === message.id,
      ),
    )
  ) {
    return turns;
  }

  const activeTurnIndex =
    activeTurnId && !turnIdsBeforeSend.has(activeTurnId)
      ? turns.findIndex(
          (turn) =>
            turn.id === activeTurnId && !hasRuntimeConversationUser(turn),
        )
      : -1;
  const acceptedTurnIndex =
    activeTurnIndex >= 0
      ? activeTurnIndex
      : findLastIndex(
          turns,
          (turn) =>
            turn.id !== null &&
            !turnIdsBeforeSend.has(turn.id) &&
            !hasRuntimeConversationUser(turn),
        );
  if (acceptedTurnIndex < 0) return appendOptimisticUser(turns, message);

  const acceptedTurn = turns[acceptedTurnIndex];
  const acceptedTurnId = acceptedTurn.id;
  if (!acceptedTurnId) return appendOptimisticUser(turns, message);
  return replaceAt(turns, acceptedTurnIndex, {
    ...acceptedTurn,
    clientUserMessageId: message.id,
    items: [
      {
        id: message.id,
        type: "user_message",
        message: {
          ...message,
          role: "user",
          subtaskId: acceptedTurnId,
          turnId: acceptedTurnId,
        },
      },
      ...acceptedTurn.items,
    ],
  });
}

export function hasRuntimeConversationUser(
  turn: RuntimeConversationTurn,
): boolean {
  return turn.items.some((item) => item.type === "user_message");
}

export function appendOptimisticUser(
  turns: RuntimeConversationTurn[],
  message: WorkbenchMessage,
): RuntimeConversationTurn[] {
  if (message.role !== "user") return turns;
  if (
    turns.some((turn) =>
      turn.items.some(
        (item) => item.type === "user_message" && item.id === message.id,
      ),
    )
  ) {
    return turns;
  }
  return [
    ...turns,
    {
      id: null,
      clientUserMessageId: message.id,
      items: [
        {
          id: message.id,
          type: "user_message",
          message: { ...message, role: "user" },
        },
      ],
      status: "pending",
      startedAt: runtimeMessageTimestamp(message),
    },
  ];
}

export function updateStartedTurn(
  turns: RuntimeConversationTurn[],
  action: Extract<RuntimePaneMessageAction, { type: "assistant_started" }>,
): RuntimeConversationTurn[] {
  if (!action.subtaskId) return turns;
  const existingIndex = turns.findIndex((turn) => turn.id === action.subtaskId);
  if (existingIndex >= 0) {
    if (turns[existingIndex].status === "cancelled") return turns;
    return replaceAt(turns, existingIndex, {
      ...turns[existingIndex],
      status: "streaming",
      startedAt:
        turns[existingIndex].startedAt ?? action.startedAt ?? Date.now(),
      durationMs: undefined,
      completedAt: undefined,
      error: undefined,
      errorType: undefined,
      stoppedNotice: undefined,
    });
  }
  const optimisticIndex = action.clientUserMessageId
    ? turns.findIndex(
        (turn) =>
          turn.clientUserMessageId === action.clientUserMessageId ||
          turn.items.some(
            (item) =>
              item.type === "user_message" &&
              item.id === action.clientUserMessageId,
          ),
      )
    : findLastIndex(
        turns,
        (turn) =>
          turn.id === null &&
          (turn.status === "pending" ||
            turn.status === "streaming" ||
            turn.status === "cancelled"),
      );
  if (optimisticIndex >= 0) {
    const optimistic = turns[optimisticIndex];
    return replaceAt(turns, optimisticIndex, {
      ...optimistic,
      id: action.subtaskId,
      status: optimistic.status === "cancelled" ? "cancelled" : "streaming",
      startedAt:
        action.startedAt ??
        optimistic.startedAt ??
        runtimeMessageTimestampFromTurn(optimistic),
      durationMs:
        optimistic.status === "cancelled" ? optimistic.durationMs : undefined,
      completedAt:
        optimistic.status === "cancelled" ? optimistic.completedAt : undefined,
      error: optimistic.status === "cancelled" ? optimistic.error : undefined,
      errorType:
        optimistic.status === "cancelled" ? optimistic.errorType : undefined,
      stoppedNotice:
        optimistic.status === "cancelled"
          ? optimistic.stoppedNotice
          : undefined,
      items: optimistic.items.map((item) =>
        item.type === "user_message"
          ? {
              ...item,
              message: {
                ...item.message,
                subtaskId: action.subtaskId,
                turnId: action.subtaskId,
              },
            }
          : item,
      ),
    });
  }
  return [
    ...turns,
    {
      id: action.subtaskId,
      clientUserMessageId: action.clientUserMessageId,
      items: [],
      status: "streaming",
      startedAt: action.startedAt ?? Date.now(),
    },
  ];
}

function runtimeMessageTimestamp(
  message: WorkbenchMessage,
): number | undefined {
  const timestamp = Date.parse(message.createdAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function runtimeMessageTimestampFromTurn(
  turn: RuntimeConversationTurn,
): number | undefined {
  const user = turn.items.find((item) => item.type === "user_message");
  return user?.type === "user_message"
    ? runtimeMessageTimestamp(user.message)
    : undefined;
}

export function updateTurn(
  turns: RuntimeConversationTurn[],
  turnId: string | undefined,
  update: (turn: RuntimeConversationTurn) => RuntimeConversationTurn,
): RuntimeConversationTurn[] {
  if (!turnId) return turns;
  const index = turns.findIndex((turn) => turn.id === turnId);
  if (index < 0) return turns;
  if (turns[index].status === "cancelled") return turns;
  return replaceAt(turns, index, update(turns[index]));
}

export function updateFailedTurn(
  turns: RuntimeConversationTurn[],
  turnId: string | undefined,
  update: (turn: RuntimeConversationTurn) => RuntimeConversationTurn,
): RuntimeConversationTurn[] {
  if (!turnId) return turns;
  const existingIndex = turns.findIndex((turn) => turn.id === turnId);
  if (existingIndex >= 0) {
    if (turns[existingIndex].status === "cancelled") return turns;
    return replaceAt(turns, existingIndex, update(turns[existingIndex]));
  }
  const optimisticIndex = findLastIndex(
    turns,
    (turn) =>
      turn.id === null &&
      (turn.status === "pending" || turn.status === "streaming"),
  );
  if (optimisticIndex >= 0) {
    const optimistic = turns[optimisticIndex];
    return replaceAt(
      turns,
      optimisticIndex,
      update({
        ...optimistic,
        id: turnId,
        items: optimistic.items.map((item) =>
          item.type === "user_message"
            ? {
                ...item,
                message: {
                  ...item.message,
                  subtaskId: turnId,
                  turnId,
                },
              }
            : item,
        ),
      }),
    );
  }
  return [
    ...turns,
    update({
      id: turnId,
      items: [],
      status: "streaming",
    }),
  ];
}

export function upsertAssistantText(
  items: RuntimeConversationItem[],
  itemId: string,
  content: string,
  contentMode: "delta" | "snapshot" | undefined,
  offset: number | undefined,
): RuntimeConversationItem[] {
  const index = items.findIndex(
    (item) => item.type === "assistant_text" && item.id === itemId,
  );
  if (index < 0) {
    return [
      ...items,
      {
        id: itemId,
        type: "assistant_text",
        content,
        streamTextOffset:
          contentMode === "snapshot" || offset === undefined
            ? undefined
            : offset + content.length,
        createdAt: new Date().toISOString(),
      },
    ];
  }
  const current = items[index];
  if (current.type !== "assistant_text") return items;
  if (contentMode === "snapshot") {
    return replaceAt(items, index, {
      ...current,
      content,
      streamTextOffset: undefined,
    });
  }
  const mergedContent =
    offset === undefined
      ? `${current.content}${content}`
      : `${current.content.slice(0, offset)}${content}${current.content.slice(
          offset + content.length,
        )}`;
  return replaceAt(items, index, {
    ...current,
    content: mergedContent,
    streamTextOffset:
      offset === undefined ? undefined : offset + content.length,
  });
}

export function applyCompletedAssistantContent(
  items: RuntimeConversationItem[],
  turnId: string | null,
  itemId: string | undefined,
  content: string | undefined,
): RuntimeConversationItem[] {
  if (!content) return items;
  const lastUserIndex = findLastIndex(
    items,
    (item) => item.type === "user_message",
  );
  const hasStreamedAssistantText = items.some(
    (item, index) => index > lastUserIndex && item.type === "assistant_text",
  );
  if (hasStreamedAssistantText) return items;
  const matchingProcessTextIndex = findLastIndex(
    items,
    (item) =>
      item.type === "block" &&
      item.block.type === "text" &&
      item.block.content === content,
  );
  if (matchingProcessTextIndex >= 0) {
    return replaceAt(items, matchingProcessTextIndex, {
      id: itemId ?? `runtime-final:${turnId ?? "pending"}`,
      type: "assistant_text",
      content,
      createdAt: new Date().toISOString(),
    });
  }
  const retained = items.filter(
    (item, index) => index <= lastUserIndex || item.type !== "assistant_text",
  );
  return [
    ...retained,
    {
      id: itemId ?? `runtime-final:${turnId ?? "pending"}`,
      type: "assistant_text",
      content,
      createdAt: new Date().toISOString(),
    },
  ];
}

export function upsertReasoningChunk(
  items: RuntimeConversationItem[],
  subtaskId: string | undefined,
  reasoningChunk: string | undefined,
): RuntimeConversationItem[] {
  if (!subtaskId || !reasoningChunk) return items;
  const itemId = `runtime-reasoning:${subtaskId}`;
  const index = items.findIndex(
    (item) => item.type === "block" && item.id === itemId,
  );
  if (index < 0) {
    const reasoningBlock: ProcessingBlock = {
      id: itemId,
      subtaskId,
      type: "thinking",
      content: reasoningChunk,
      status: "streaming",
      createdAt: Date.now(),
    };
    const block =
      limitWorkbenchProcessingBlock<TurnFileChangesSummary>(reasoningBlock);
    return [
      ...items,
      {
        id: itemId,
        type: "block",
        block,
      },
    ];
  }
  const current = items[index];
  if (current.type !== "block" || current.block.type !== "thinking")
    return items;
  const content = `${current.block.content}${reasoningChunk}`;
  return replaceAt(items, index, {
    ...current,
    block: limitWorkbenchProcessingBlock({
      ...current.block,
      content,
      contentOriginalChars:
        (current.block.contentOriginalChars ?? current.block.content.length) +
        reasoningChunk.length,
      status: "streaming",
    }),
  });
}

export function upsertBlocks(
  items: RuntimeConversationItem[],
  blocks: ProcessingBlock[] | undefined,
): RuntimeConversationItem[] {
  if (!blocks?.length) return items;
  let next = items;
  for (const block of blocks) {
    const exactIndex = next.findIndex(
      (item) => item.type === "block" && item.id === block.id,
    );
    const contextCompactionIndex =
      exactIndex < 0 && isContextCompactionBlock(block)
        ? next.findIndex(
            (item) =>
              item.type === "block" &&
              item.block.subtaskId === block.subtaskId &&
              isContextCompactionBlock(item.block),
          )
        : -1;
    const index = exactIndex >= 0 ? exactIndex : contextCompactionIndex;
    const canonicalItem: RuntimeConversationItem = {
      id: block.id,
      type: "block",
      block: limitWorkbenchProcessingBlock(
        index >= 0 && next[index]?.type === "block"
          ? preserveProcessingBlockTiming(next[index].block, block)
          : block,
      ),
    };
    next =
      index < 0
        ? insertRuntimeBlockBeforeLaterGuidance(next, canonicalItem)
        : replaceAt(next, index, canonicalItem);
  }
  return next;
}

export function insertRuntimeBlockBeforeLaterGuidance(
  items: RuntimeConversationItem[],
  blockItem: Extract<RuntimeConversationItem, { type: "block" }>,
): RuntimeConversationItem[] {
  const guidanceIndex = items.findIndex((item) => {
    if (item.type !== "user_message" || item.message.runtimeGuidance !== true)
      return false;
    const guidanceCreatedAt = Date.parse(item.message.createdAt ?? "");
    return (
      Number.isFinite(guidanceCreatedAt) &&
      blockItem.block.createdAt <= guidanceCreatedAt
    );
  });
  if (guidanceIndex < 0) return [...items, blockItem];
  const next = [...items];
  next.splice(guidanceIndex, 0, blockItem);
  return next;
}

export function isContextCompactionBlock(block: ProcessingBlock): boolean {
  return block.type === "tool" && block.toolName === "context_compaction";
}

export function replaceAssistantTextWithBlock(
  items: RuntimeConversationItem[],
  assistantTextItemId: string | undefined,
  block: ProcessingBlock,
): RuntimeConversationItem[] {
  if (!assistantTextItemId) return upsertBlocks(items, [block]);
  const index = items.findIndex(
    (item) => item.type === "assistant_text" && item.id === assistantTextItemId,
  );
  if (index < 0) return upsertBlocks(items, [block]);
  return replaceAt(items, index, {
    id: block.id,
    type: "block",
    block: limitWorkbenchProcessingBlock(block),
  });
}

export function upsertRuntimeBlock(
  items: RuntimeConversationItem[],
  assistantTextItemId: string | undefined,
  block: ProcessingBlock,
  turnStatus: RuntimeConversationTurn["status"],
): RuntimeConversationItem[] {
  if (assistantTextItemId) {
    return replaceAssistantTextWithBlock(items, assistantTextItemId, block);
  }

  const existingIndex = items.findIndex((item) => item.id === block.id);
  if (existingIndex >= 0) {
    if (
      items[existingIndex]?.type === "assistant_text" &&
      (turnStatus === "done" || block.type === "text")
    ) {
      return items;
    }
    return upsertBlocks(items, [block]);
  }
  if (turnStatus !== "done") {
    return block.type === "subagent"
      ? insertDelayedSubagentBlock(items, block)
      : upsertBlocks(items, [block]);
  }

  const terminalTextIndex = findLastIndex(
    items,
    (item) => item.type === "assistant_text",
  );
  if (terminalTextIndex < 0) return upsertBlocks(items, [block]);
  const nextItems = [...items];
  nextItems.splice(terminalTextIndex, 0, {
    id: block.id,
    type: "block",
    block: limitWorkbenchProcessingBlock(block),
  });
  return nextItems;
}

export function insertDelayedSubagentBlock(
  items: RuntimeConversationItem[],
  block: Extract<ProcessingBlock, { type: "subagent" }>,
): RuntimeConversationItem[] {
  const blockItem: Extract<RuntimeConversationItem, { type: "block" }> = {
    id: block.id,
    type: "block",
    block: limitWorkbenchProcessingBlock(block),
  };
  const insertionIndex = items.findIndex((item) => {
    if (item.type === "user_message") {
      if (item.message.runtimeGuidance !== true) return false;
      const createdAt = Date.parse(item.message.createdAt ?? "");
      return Number.isFinite(createdAt) && createdAt > block.createdAt;
    }
    const createdAt =
      item.type === "assistant_text"
        ? Date.parse(item.createdAt)
        : item.block.createdAt;
    return Number.isFinite(createdAt) && createdAt > block.createdAt;
  });
  if (insertionIndex < 0) return [...items, blockItem];
  const nextItems = [...items];
  nextItems.splice(insertionIndex, 0, blockItem);
  return nextItems;
}

export function resolveRuntimeStreamingThinkingContent(
  turn: RuntimeConversationTurn,
  action: Extract<RuntimePaneMessageAction, { type: "assistant_chunk" }>,
  items: RuntimeConversationItem[],
): string | undefined {
  return resolveStreamingThinkingContent({
    previousContent: turn.streamingThinkingContent,
    reasoningChunk: action.reasoningChunk,
    content: action.content,
    incomingBlocks: action.blocks,
    blocks: processingBlocks(items),
  });
}

export function boundVisibleRuntimeProcessingBlocks(
  turn: RuntimeConversationTurn,
  items: RuntimeConversationItem[],
): Pick<RuntimeConversationTurn, "items" | "contentTruncated"> {
  const blockCount = items.reduce(
    (count, item) => count + (item.type === "block" ? 1 : 0),
    0,
  );
  if (blockCount <= MAX_VISIBLE_RUNTIME_PROCESSING_BLOCKS) {
    return {
      items,
      contentTruncated: turn.contentTruncated,
    };
  }

  let blocksToDrop = blockCount - MAX_VISIBLE_RUNTIME_PROCESSING_BLOCKS;
  return {
    items: items.filter((item) => {
      if (item.type !== "block" || blocksToDrop <= 0) return true;
      blocksToDrop -= 1;
      return false;
    }),
    contentTruncated: true,
  };
}

export function settleProcessingBlocks(
  items: RuntimeConversationItem[],
): RuntimeConversationItem[] {
  const completedAt = Date.now();
  return items.map((item) => {
    if (item.type !== "block") return item;
    if (item.block.status === "done" || item.block.status === "error")
      return item;
    return {
      ...item,
      block: {
        ...item.block,
        status: "done",
        completedAt: item.block.completedAt ?? completedAt,
      } as ProcessingBlock,
    };
  });
}

export function settleRuntimeReconnectingBlocks(
  items: RuntimeConversationItem[],
): RuntimeConversationItem[] {
  // A WebView refresh can miss the dedicated completion event. Any later turn
  // progress proves the connection recovered, so the transient block must settle.
  const completedAt = Date.now();
  return items.map((item) => {
    if (
      item.type !== "block" ||
      !isRuntimeReconnectingBlock(item.block) ||
      item.block.status === "done" ||
      item.block.status === "error"
    ) {
      return item;
    }
    return {
      ...item,
      block: {
        ...item.block,
        status: "done",
        completedAt: item.block.completedAt ?? completedAt,
      },
    };
  });
}

export function hasAssistantChunkProgress(
  action: Extract<RuntimePaneMessageAction, { type: "assistant_chunk" }>,
): boolean {
  if (action.content || action.reasoningChunk) return true;
  return Boolean(
    action.blocks?.some((block) => !isRuntimeReconnectingBlock(block)),
  );
}

export function isRuntimeReconnectingBlock(block: ProcessingBlock): boolean {
  return (
    block.type === "tool" && block.toolName === RUNTIME_RECONNECTING_TOOL_NAME
  );
}

export function mergeProcessingBlockUpdate(
  block: ProcessingBlock,
  updates: Extract<
    RuntimePaneMessageAction,
    { type: "block_updated" }
  >["updates"],
): ProcessingBlock {
  const { contentDelta, durationMs, ...directUpdates } = updates;
  let merged = {
    ...block,
    ...directUpdates,
    ...(durationMs !== undefined && {
      durationMs: Math.max(0, durationMs),
      completedAt: block.createdAt + Math.max(0, durationMs),
    }),
  } as ProcessingBlock;
  if (
    typeof contentDelta === "string" &&
    (merged.type === "thinking" ||
      merged.type === "text" ||
      merged.type === "plan")
  ) {
    const previousContentChars =
      block.contentOriginalChars ??
      ("content" in block ? block.content.length : 0);
    merged = {
      ...merged,
      content: `${merged.content}${contentDelta}`,
      contentOriginalChars: previousContentChars + contentDelta.length,
    } as ProcessingBlock;
  }
  if (merged.type === "tool" && block.type === "tool") {
    merged.toolInput = updates.toolInput ?? block.toolInput;
  }
  const wasActive = block.status !== "done" && block.status !== "error";
  const isComplete = merged.status === "done" || merged.status === "error";
  if (wasActive && isComplete && merged.completedAt === undefined) {
    merged = { ...merged, completedAt: Date.now() } as ProcessingBlock;
  }
  return limitWorkbenchProcessingBlock(merged);
}

export function replaceAt<T>(items: T[], index: number, item: T): T[] {
  return [...items.slice(0, index), item, ...items.slice(index + 1)];
}

function findLastIndex<T>(
  items: T[],
  predicate: (item: T, index: number) => boolean,
): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index], index)) return index;
  }
  return -1;
}
