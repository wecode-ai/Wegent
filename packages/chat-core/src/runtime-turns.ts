import { processingBlocks } from "./runtime-turn-helpers";
import type { RuntimePaneMessageAction } from "./runtime-conversation";

import { getLatestThinkingContent } from "./workbench-message-reducer";

import type {
  RuntimeConversationItem,
  RuntimeConversationTurn,
  WorkbenchMessage,
} from "./runtime-conversation";
import {
  mergeRuntimeConversationTurn,
  orderRuntimeConversationTurns,
  isTerminalProcessingBlockStatus,
} from "./runtime-turn-merge";
import {
  seedRuntimeConversationTurns,
  appendOptimisticUser,
  updateStartedTurn,
  updateTurn,
  updateFailedTurn,
  upsertAssistantText,
  applyCompletedAssistantContent,
  upsertReasoningChunk,
  upsertBlocks,
  upsertRuntimeBlock,
  resolveRuntimeStreamingThinkingContent,
  boundVisibleRuntimeProcessingBlocks,
  settleProcessingBlocks,
  settleRuntimeReconnectingBlocks,
  hasAssistantChunkProgress,
  isRuntimeReconnectingBlock,
  mergeProcessingBlockUpdate,
  replaceAt,
} from "./runtime-turn-updates";
import { projectRuntimeConversationTurn } from "./runtime-turn-projection";

export function mergeRuntimeConversationTurns(
  localTurns: RuntimeConversationTurn[],
  snapshotTurns: RuntimeConversationTurn[],
): RuntimeConversationTurn[] {
  if (snapshotTurns.length === 0) return localTurns;
  const localIndexByTurnId = new Map(
    localTurns.flatMap((turn, index) =>
      turn.id === null ? [] : [[turn.id, index] as const],
    ),
  );
  const localIndexByClientUserMessageId = new Map(
    localTurns.flatMap((turn, index) =>
      runtimeConversationTurnClientUserMessageIds(turn).map(
        (id) => [id, index] as const,
      ),
    ),
  );
  const emittedLocalIndexes = new Set<number>();
  const snapshotUserMessageIds = new Set(
    snapshotTurns.flatMap(runtimeConversationTurnClientUserMessageIds),
  );
  const snapshotIndexByAssistantItemId =
    uniqueSnapshotIndexByAssistantItemId(snapshotTurns);
  const merged = snapshotTurns.map((snapshotTurn) => {
    const localIndex =
      (snapshotTurn.id === null
        ? undefined
        : localIndexByTurnId.get(snapshotTurn.id)) ??
      runtimeConversationTurnClientUserMessageIds(snapshotTurn)
        .map((id) => localIndexByClientUserMessageId.get(id))
        .find((index): index is number => index !== undefined);
    if (localIndex === undefined) return snapshotTurn;
    emittedLocalIndexes.add(localIndex);
    return mergeRuntimeConversationTurn(localTurns[localIndex], snapshotTurn);
  });

  localTurns.forEach((turn, index) => {
    if (emittedLocalIndexes.has(index)) return;
    const aliasSnapshotIndexes = new Set(
      runtimeConversationTurnAssistantItemIds(turn)
        .map((id) => snapshotIndexByAssistantItemId.get(id))
        .filter(
          (snapshotIndex): snapshotIndex is number =>
            snapshotIndex !== undefined,
        ),
    );
    if (aliasSnapshotIndexes.size === 1) {
      const snapshotIndex = aliasSnapshotIndexes.values().next().value;
      if (snapshotIndex !== undefined) {
        merged[snapshotIndex] = mergeRuntimeConversationTurn(
          turn,
          merged[snapshotIndex],
        );
        return;
      }
    }
    if (
      runtimeConversationTurnClientUserMessageIds(turn).some((id) =>
        snapshotUserMessageIds.has(id),
      )
    ) {
      return;
    }
    if (
      turn.id === null ||
      !snapshotTurns.some((snapshotTurn) => snapshotTurn.id === turn.id)
    ) {
      merged.push(turn);
    }
  });
  return orderRuntimeConversationTurns(merged);
}

export function uniqueSnapshotIndexByAssistantItemId(
  turns: RuntimeConversationTurn[],
): Map<string, number> {
  const indexes = new Map<string, number>();
  const duplicates = new Set<string>();
  turns.forEach((turn, index) => {
    runtimeConversationTurnAssistantItemIds(turn).forEach((id) => {
      const existing = indexes.get(id);
      if (existing === undefined) {
        indexes.set(id, index);
      } else if (existing !== index) {
        duplicates.add(id);
      }
    });
  });
  duplicates.forEach((id) => indexes.delete(id));
  return indexes;
}

export function runtimeConversationTurnClientUserMessageIds(
  turn: RuntimeConversationTurn,
): string[] {
  return Array.from(
    new Set([
      ...(turn.clientUserMessageId ? [turn.clientUserMessageId] : []),
      ...turn.items.flatMap((item) =>
        item.type === "user_message" ? [item.id] : [],
      ),
    ]),
  );
}

export function runtimeConversationTurnAssistantItemIds(
  turn: RuntimeConversationTurn,
): string[] {
  return turn.items.flatMap((item) =>
    item.type === "user_message" ? [] : [item.id],
  );
}

export function reduceRuntimeConversationTurns(
  turns: RuntimeConversationTurn[],
  action: RuntimePaneMessageAction,
): RuntimeConversationTurn[] {
  switch (action.type) {
    case "reset":
      return seedRuntimeConversationTurns(action.messages, turns);
    case "user_added":
      return appendOptimisticUser(turns, action.message);
    case "assistant_started":
      return updateStartedTurn(turns, action);
    case "assistant_chunk":
      return updateTurn(turns, action.subtaskId, (turn) => {
        let items = hasAssistantChunkProgress(action)
          ? settleRuntimeReconnectingBlocks(turn.items)
          : turn.items;
        items = upsertReasoningChunk(
          items,
          action.subtaskId,
          action.reasoningChunk,
        );
        items = upsertBlocks(items, action.blocks);
        if (action.content) {
          if (action.itemId) {
            items = upsertAssistantText(
              items,
              action.itemId,
              action.content,
              action.contentMode,
              action.offset,
            );
          } else {
            console.warn(
              "[Wework] Dropped runtime assistant text without Codex item identity",
              {
                subtaskId: action.subtaskId,
              },
            );
          }
        }
        return {
          ...turn,
          ...boundVisibleRuntimeProcessingBlocks(turn, items),
          status: "streaming",
          streamingThinkingContent: resolveRuntimeStreamingThinkingContent(
            turn,
            action,
            items,
          ),
        };
      });
    case "assistant_done":
      return updateTurn(turns, action.subtaskId, (turn) => {
        const items = applyCompletedAssistantContent(
          settleProcessingBlocks(
            upsertBlocks(
              settleRuntimeReconnectingBlocks(turn.items),
              action.blocks,
            ),
          ),
          turn.id,
          action.itemId,
          action.content,
        );
        return {
          ...turn,
          ...boundVisibleRuntimeProcessingBlocks(turn, items),
          status: "done",
          streamingThinkingContent: undefined,
          startedAt: action.startedAt ?? turn.startedAt,
          durationMs: action.durationMs,
          completedAt: new Date().toISOString(),
          fileChanges: action.fileChanges ?? turn.fileChanges,
          error: undefined,
          errorType: undefined,
        };
      });
    case "assistant_cancelled":
      return updateTurn(turns, action.subtaskId, (turn) => {
        return {
          ...turn,
          items: settleRuntimeReconnectingBlocks(turn.items),
          status: "cancelled",
          streamingThinkingContent: undefined,
          startedAt: action.startedAt ?? turn.startedAt,
          durationMs: action.durationMs,
          completedAt: new Date().toISOString(),
          stoppedNotice: true,
        };
      });
    case "assistant_error":
      return updateFailedTurn(turns, action.subtaskId, (turn) => {
        return {
          ...turn,
          items: settleRuntimeReconnectingBlocks(turn.items),
          status: "failed",
          streamingThinkingContent: undefined,
          startedAt: action.startedAt ?? turn.startedAt,
          durationMs: action.durationMs,
          completedAt: new Date().toISOString(),
          error: action.error,
          errorType: action.errorType,
        };
      });
    case "file_changes_updated":
      return updateTurn(turns, action.subtaskId, (turn) => ({
        ...turn,
        fileChanges: action.fileChanges,
      }));
    case "block_created":
      return updateTurn(turns, action.subtaskId, (turn) => {
        const currentItems = isRuntimeReconnectingBlock(action.block)
          ? turn.items
          : settleRuntimeReconnectingBlocks(turn.items);
        const items = upsertRuntimeBlock(
          currentItems,
          action.replaceAssistantTextItemId,
          action.block,
          turn.status,
        );
        return {
          ...turn,
          ...boundVisibleRuntimeProcessingBlocks(turn, items),
          ...(!isTerminalProcessingBlockStatus(action.block.status) && {
            status: "streaming" as const,
            completedAt: undefined,
            error: undefined,
            errorType: undefined,
            stoppedNotice: undefined,
          }),
          streamingThinkingContent:
            action.block.type === "thinking" || action.block.type === "tool"
              ? getLatestThinkingContent(processingBlocks(items))
              : action.block.type === "text" || action.block.type === "plan"
                ? undefined
                : turn.streamingThinkingContent,
        };
      });
    case "block_updated":
      return updateTurn(turns, action.subtaskId, (turn) => {
        const currentItems = turn.items.some(
          (item) =>
            item.type === "block" &&
            item.id === action.blockId &&
            isRuntimeReconnectingBlock(item.block),
        )
          ? turn.items
          : settleRuntimeReconnectingBlocks(turn.items);
        const previousBlock = turn.items.find(
          (item) => item.type === "block" && item.id === action.blockId,
        );
        const items = currentItems.map((item) =>
          item.type === "block" && item.id === action.blockId
            ? {
                ...item,
                block: mergeProcessingBlockUpdate(item.block, action.updates),
              }
            : item,
        );
        return {
          ...turn,
          items,
          ...(action.updates.status !== undefined &&
            !isTerminalProcessingBlockStatus(action.updates.status) && {
              status: "streaming" as const,
              completedAt: undefined,
              error: undefined,
              errorType: undefined,
              stoppedNotice: undefined,
            }),
          streamingThinkingContent:
            previousBlock?.type === "block" &&
            previousBlock.block.type === "thinking"
              ? getLatestThinkingContent(processingBlocks(items))
              : previousBlock?.type === "block" &&
                  (previousBlock.block.type === "text" ||
                    previousBlock.block.type === "plan")
                ? undefined
                : turn.streamingThinkingContent,
        };
      });
  }
}

export function projectRuntimeConversationTurns(
  turns: RuntimeConversationTurn[],
): WorkbenchMessage[] {
  return turns.flatMap(projectRuntimeConversationTurn);
}

export function appendRuntimeConversationGuidance(
  turns: RuntimeConversationTurn[],
  turnId: string | undefined,
  guidance: WorkbenchMessage & { role: "user"; runtimeGuidance: true },
): RuntimeConversationTurn[] {
  if (!turnId) return turns;
  const withoutOptimisticDuplicate = turns
    .filter(
      (turn) =>
        !(
          turn.id === null &&
          turn.clientUserMessageId === guidance.id &&
          turn.items.every(
            (item) => item.type === "user_message" && item.id === guidance.id,
          )
        ),
    )
    .map((turn) =>
      turn.id !== turnId
        ? {
            ...turn,
            items: turn.items.filter(
              (item) => item.type !== "user_message" || item.id !== guidance.id,
            ),
          }
        : turn,
    );
  return updateTurn(withoutOptimisticDuplicate, turnId, (turn) => {
    const existingIndex = turn.items.findIndex(
      (item) => item.type === "user_message" && item.id === guidance.id,
    );
    if (existingIndex >= 0) {
      return {
        ...turn,
        items: replaceAt(turn.items, existingIndex, {
          id: guidance.id,
          type: "user_message",
          message: { ...guidance, subtaskId: turnId, turnId },
        }),
      };
    }
    const userItem: RuntimeConversationItem = {
      id: guidance.id,
      type: "user_message",
      message: { ...guidance, subtaskId: turnId, turnId },
    };
    return {
      ...turn,
      items: [...turn.items, userItem],
    };
  });
}
