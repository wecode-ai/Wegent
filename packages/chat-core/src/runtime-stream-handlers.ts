import {
  isStandaloneCompletedContextCompaction,
  isRuntimeTaskStreamPayload,
  runtimeStreamTaskSubtaskIdentity,
  warnAndDropRuntimeStreamEvent,
  warnAndDropMismatchedRuntimeTerminalEvent,
  logAcceptedRuntimeTerminalEvent,
  warnAndDropEmptyRuntimeChunk,
  isCancelledRuntimeError,
  normalizeChatBlock,
  getResultBlocks,
  fileChangesFromBlocks,
  rememberStreamedFileChanges,
  getReasoningChunk,
  type RuntimeStreamDiagnostics,
  debugRuntimeStreamEvent,
} from "./runtime-stream-helpers";
export {
  findFileChangesBySubtaskId,
  runtimeAddressDebug,
  runtimeTranscriptDebug,
} from "./runtime-stream-helpers";
export {
  runtimeMessagesToWorkbenchMessages,
  runtimeTranscriptTurnsToConversationTurns,
} from "./runtime-transcript";
import { isRecord } from "./runtime-transcript-blocks";
import type {
  ChatStreamHandlers,
  RuntimeTransportReplacedPayload,
} from "./runtime-stream-types";

import type {
  Attachment,
  RuntimeContextUsage,
  RuntimeTaskAddress,
  TurnFileChangesSummary,
} from "./runtime";
import type {
  RuntimeGoalEventPayload,
  RuntimeGoalContinuationPayload,
  RuntimePlanEventPayload,
  RuntimeTaskTitleUpdatedPayload,
  RuntimeGuidanceAppliedPayload,
  RuntimeSubagentActivityPayload,
  RuntimeSupervisorEventPayload,
} from "./runtime-stream-types";

import type { MessageSource } from "./runtime-conversation";

import {
  mergeTurnFileChanges,
  normalizeTurnFileChanges,
} from "./turn-file-changes";
import {
  normalizeWorkbenchBlockStatus,
  type WorkbenchMessageAction,
} from "./workbench-message-reducer";

export const MAX_RUNTIME_TASK_STREAM_HANDLERS = 50;
export const MAX_RUNTIME_SETTLED_ASSISTANT_TURN_IDS = 256;

export type RuntimePaneMessageAction = WorkbenchMessageAction<
  Attachment,
  TurnFileChangesSummary
>;

export interface RuntimeTaskStreamHandlers {
  onMessageAction: (action: RuntimePaneMessageAction) => void;
  onAssistantStart?: (turnId: string) => void;
  onAssistantFirstToken?: (turnId: string) => void;
  onAssistantResponseSize?: (turnId: string, responseSizeBytes: number) => void;
  onAssistantSettled?: (
    turnId: string,
    outcome: "succeeded" | "failed" | "cancelled",
  ) => void;
  onContextUsageUpdated?: (usage: RuntimeContextUsage) => void;
  onSubagentActivity?: (payload: RuntimeSubagentActivityPayload) => void;
  onRuntimeTaskTitleUpdated?: (payload: RuntimeTaskTitleUpdatedPayload) => void;
  onRuntimeGoalUpdated?: (payload: RuntimeGoalEventPayload) => void;
  onRuntimeGoalCleared?: (payload: RuntimeGoalEventPayload) => void;
  onRuntimeSupervisorUpdated?: (payload: RuntimeSupervisorEventPayload) => void;
  onRuntimeGoalContinuation?: (payload: RuntimeGoalContinuationPayload) => void;
  onRuntimePlanUpdated?: (payload: RuntimePlanEventPayload) => void;
  onGuidanceApplied?: (payload: RuntimeGuidanceAppliedPayload) => void;
  onRuntimeTransportReplaced?: (
    payload: RuntimeTransportReplacedPayload,
  ) => void;
}

export interface RuntimeConversationStreamHandlers {
  onMessageAction: (
    address: RuntimeTaskAddress,
    action: RuntimePaneMessageAction,
  ) => void;
  onAssistantStart?: (address: RuntimeTaskAddress, turnId: string) => void;
  onAssistantFirstToken?: (address: RuntimeTaskAddress, turnId: string) => void;
  onAssistantResponseSize?: (
    address: RuntimeTaskAddress,
    turnId: string,
    responseSizeBytes: number,
  ) => void;
  onAssistantSettled?: (
    address: RuntimeTaskAddress,
    turnId: string,
    outcome: "succeeded" | "failed" | "cancelled",
  ) => void;
  onContextUsageUpdated?: (
    address: RuntimeTaskAddress,
    usage: RuntimeContextUsage,
  ) => void;
  onSubagentActivity?: (
    address: RuntimeTaskAddress,
    payload: RuntimeSubagentActivityPayload,
  ) => void;
  onRuntimeTaskTitleUpdated?: (
    address: RuntimeTaskAddress,
    payload: RuntimeTaskTitleUpdatedPayload,
  ) => void;
  onRuntimeGoalUpdated?: (
    address: RuntimeTaskAddress,
    payload: RuntimeGoalEventPayload,
  ) => void;
  onRuntimeGoalCleared?: (
    address: RuntimeTaskAddress,
    payload: RuntimeGoalEventPayload,
  ) => void;
  onRuntimeSupervisorUpdated?: (
    address: RuntimeTaskAddress,
    payload: RuntimeSupervisorEventPayload,
  ) => void;
  onRuntimeGoalContinuation?: (
    address: RuntimeTaskAddress,
    payload: RuntimeGoalContinuationPayload,
  ) => void;
  onRuntimePlanUpdated?: (
    address: RuntimeTaskAddress,
    payload: RuntimePlanEventPayload,
  ) => void;
  onGuidanceApplied?: (
    address: RuntimeTaskAddress,
    payload: RuntimeGuidanceAppliedPayload,
  ) => void;
  onRuntimeTransportReplaced?: (
    payload: RuntimeTransportReplacedPayload,
  ) => void;
}

export function createRuntimeConversationStreamHandlers(
  handlers: RuntimeConversationStreamHandlers,
  diagnostics?: RuntimeStreamDiagnostics,
): ChatStreamHandlers {
  const taskHandlers = new Map<
    string,
    {
      handlers: ChatStreamHandlers;
      activeTurnIds: Set<string>;
    }
  >();

  const evictSettledTaskHandlers = () => {
    while (taskHandlers.size > MAX_RUNTIME_TASK_STREAM_HANDLERS) {
      let settledKey: string | undefined;
      for (const [key, entry] of taskHandlers) {
        if (entry.activeTurnIds.size > 0) continue;
        settledKey = key;
        break;
      }
      if (settledKey === undefined) return;
      taskHandlers.delete(settledKey);
    }
  };

  const resolve = (payload: { deviceId?: string; taskId?: string }) => {
    if (!payload.deviceId || !payload.taskId) {
      console.warn("[Wework] Dropped runtime event without task address", {
        deviceId: payload.deviceId ?? null,
        taskId: payload.taskId ?? null,
      });
      return null;
    }
    const address = {
      deviceId: payload.deviceId,
      taskId: payload.taskId,
    };
    const key = `${address.deviceId}:${address.taskId}`;
    const existing = taskHandlers.get(key);
    if (existing) {
      taskHandlers.delete(key);
      taskHandlers.set(key, existing);
      return existing;
    }

    const activeTurnIds = new Set<string>();
    const streamHandlers = createRuntimeTaskStreamHandlers(
      address,
      {
        onMessageAction: (action) => handlers.onMessageAction(address, action),
        onAssistantStart: (turnId) => {
          activeTurnIds.add(turnId);
          handlers.onAssistantStart?.(address, turnId);
        },
        onAssistantFirstToken: (turnId) =>
          handlers.onAssistantFirstToken?.(address, turnId),
        onAssistantResponseSize: (turnId, responseSizeBytes) =>
          handlers.onAssistantResponseSize?.(
            address,
            turnId,
            responseSizeBytes,
          ),
        onAssistantSettled: (turnId, outcome) => {
          activeTurnIds.delete(turnId);
          handlers.onAssistantSettled?.(address, turnId, outcome);
        },
        onContextUsageUpdated: (usage) =>
          handlers.onContextUsageUpdated?.(address, usage),
        onSubagentActivity: (payload) =>
          handlers.onSubagentActivity?.(address, payload),
        onRuntimeTaskTitleUpdated: (payload) =>
          handlers.onRuntimeTaskTitleUpdated?.(address, payload),
        onRuntimeGoalUpdated: (payload) =>
          handlers.onRuntimeGoalUpdated?.(address, payload),
        onRuntimeGoalCleared: (payload) =>
          handlers.onRuntimeGoalCleared?.(address, payload),
        onRuntimeSupervisorUpdated: (payload) =>
          handlers.onRuntimeSupervisorUpdated?.(address, payload),
        onRuntimeGoalContinuation: (payload) =>
          handlers.onRuntimeGoalContinuation?.(address, payload),
        onRuntimePlanUpdated: (payload) =>
          handlers.onRuntimePlanUpdated?.(address, payload),
        onGuidanceApplied: (payload) =>
          handlers.onGuidanceApplied?.(address, payload),
      },
      diagnostics,
    );
    const created = { handlers: streamHandlers, activeTurnIds };
    taskHandlers.set(key, created);
    return created;
  };

  const forward = (
    payload: { deviceId?: string; taskId?: string },
    dispatch: (streamHandlers: ChatStreamHandlers) => void,
  ) => {
    const entry = resolve(payload);
    if (!entry) return;
    dispatch(entry.handlers);
    evictSettledTaskHandlers();
  };

  return {
    onChatStart: (payload) =>
      forward(payload, (entry) => entry.onChatStart?.(payload)),
    onChatChunk: (payload) =>
      forward(payload, (entry) => entry.onChatChunk?.(payload)),
    onChatDone: (payload) =>
      forward(payload, (entry) => entry.onChatDone?.(payload)),
    onChatError: (payload) =>
      forward(payload, (entry) => entry.onChatError?.(payload)),
    onBlockCreated: (payload) =>
      forward(payload, (entry) => entry.onBlockCreated?.(payload)),
    onBlockUpdated: (payload) =>
      forward(payload, (entry) => entry.onBlockUpdated?.(payload)),
    onSubagentActivity: (payload) =>
      forward(payload, (entry) => entry.onSubagentActivity?.(payload)),
    onRuntimeTaskTitleUpdated: (payload) =>
      forward(payload, (entry) => entry.onRuntimeTaskTitleUpdated?.(payload)),
    onRuntimeGoalUpdated: (payload) =>
      forward(payload, (entry) => entry.onRuntimeGoalUpdated?.(payload)),
    onRuntimeGoalCleared: (payload) =>
      forward(payload, (entry) => entry.onRuntimeGoalCleared?.(payload)),
    onRuntimeSupervisorUpdated: (payload) =>
      forward(payload, (entry) => entry.onRuntimeSupervisorUpdated?.(payload)),
    onRuntimeGoalContinuation: (payload) =>
      forward(payload, (entry) => entry.onRuntimeGoalContinuation?.(payload)),
    onRuntimePlanUpdated: (payload) =>
      forward(payload, (entry) => entry.onRuntimePlanUpdated?.(payload)),
    onGuidanceApplied: (payload) =>
      forward(payload, (entry) => entry.onGuidanceApplied?.(payload)),
    onRuntimeTransportReplaced: (payload) =>
      handlers.onRuntimeTransportReplaced?.(payload),
  };
}

export function createRuntimeTaskStreamHandlers(
  address: RuntimeTaskAddress,
  handlers: RuntimeTaskStreamHandlers,
  diagnostics?: RuntimeStreamDiagnostics,
): ChatStreamHandlers {
  const streamedFileChanges = new Map<
    string,
    Map<string, TurnFileChangesSummary>
  >();
  const firstTokenSent = new Set<string>();
  const unsettledAssistantTurnIds = new Set<string>();
  const settledAssistantTurnIds = new Set<string>();
  const rememberSettledAssistantTurn = (turnId: string) => {
    settledAssistantTurnIds.delete(turnId);
    settledAssistantTurnIds.add(turnId);
    while (
      settledAssistantTurnIds.size > MAX_RUNTIME_SETTLED_ASSISTANT_TURN_IDS
    ) {
      const oldestTurnId = settledAssistantTurnIds.values().next().value;
      if (oldestTurnId === undefined) return;
      settledAssistantTurnIds.delete(oldestTurnId);
    }
  };
  const settleAssistantTurn = (
    terminalTurnId: string,
    outcome: "succeeded" | "failed" | "cancelled",
    allowProviderAlias = true,
  ) => {
    if (settledAssistantTurnIds.has(terminalTurnId)) return;

    let lifecycleTurnId = terminalTurnId;
    if (unsettledAssistantTurnIds.has(terminalTurnId)) {
      unsettledAssistantTurnIds.delete(terminalTurnId);
    } else if (allowProviderAlias && unsettledAssistantTurnIds.size > 0) {
      lifecycleTurnId =
        unsettledAssistantTurnIds.values().next().value ?? terminalTurnId;
      unsettledAssistantTurnIds.delete(lifecycleTurnId);
    }
    firstTokenSent.delete(terminalTurnId);
    firstTokenSent.delete(lifecycleTurnId);
    rememberSettledAssistantTurn(terminalTurnId);
    rememberSettledAssistantTurn(lifecycleTurnId);
    handlers.onAssistantSettled?.(lifecycleTurnId, outcome);
  };

  const streamHandlers: ChatStreamHandlers = {
    scope: {
      deviceId: address.deviceId,
      taskId: address.taskId,
    },
    onChatStart: (payload) => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return;
      const identity = runtimeStreamTaskSubtaskIdentity(payload);
      if (!identity) {
        warnAndDropRuntimeStreamEvent("chat:start", address, payload);
        return;
      }
      debugRuntimeStreamEvent(
        diagnostics,
        "chat:start",
        address,
        payload,
        true,
      );

      if (payload.runtimeGeneratedUserMessage) {
        handlers.onMessageAction({
          type: "user_added",
          message: {
            id: payload.runtimeGeneratedUserMessage.id,
            taskId: address.taskId,
            role: "user",
            content: payload.runtimeGeneratedUserMessage.message,
            status: "done",
            source: payload.runtimeGeneratedUserMessage.source as MessageSource,
            createdAt: new Date(
              payload.runtimeGeneratedUserMessage.createdAt,
            ).toISOString(),
          },
        });
      }
      if (settledAssistantTurnIds.has(identity.subtaskId)) return;
      unsettledAssistantTurnIds.add(identity.subtaskId);
      handlers.onAssistantStart?.(identity.subtaskId);
      handlers.onMessageAction({
        type: "assistant_started",
        taskId: payload.taskId,
        subtaskId: identity.subtaskId,
        clientUserMessageId: payload.clientUserMessageId,
        shellType: payload.shellType,
      });
    },
    onChatChunk: (payload) => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return;
      const contextUsage = payload.result?.contextUsage;
      const identity = runtimeStreamTaskSubtaskIdentity(payload);
      const reasoningChunk = getReasoningChunk(payload.result);
      if (!identity) {
        if (contextUsage && !payload.content && !reasoningChunk) {
          handlers.onContextUsageUpdated?.(contextUsage);
          return;
        }
        warnAndDropRuntimeStreamEvent("chat:chunk", address, payload, {
          hasContent: Boolean(payload.content),
          hasReasoningChunk: Boolean(reasoningChunk),
        });
        return;
      }
      if (settledAssistantTurnIds.has(identity.subtaskId)) return;
      const blocks = getResultBlocks(identity.subtaskId, payload.result);
      if (
        !payload.content &&
        !reasoningChunk &&
        (!blocks || blocks.length === 0)
      ) {
        if (contextUsage) {
          handlers.onContextUsageUpdated?.(contextUsage);
          return;
        }
        warnAndDropEmptyRuntimeChunk(address, payload, {
          reason: "empty_chunk",
          resultKeys: isRecord(payload.result)
            ? Object.keys(payload.result)
            : [],
        });
        return;
      }
      if (contextUsage) {
        handlers.onContextUsageUpdated?.(contextUsage);
      }
      if (payload.content || reasoningChunk) {
        if (!firstTokenSent.has(identity.subtaskId)) {
          firstTokenSent.add(identity.subtaskId);
          handlers.onAssistantFirstToken?.(identity.subtaskId);
        }
      }
      debugRuntimeStreamEvent(
        diagnostics,
        "chat:chunk",
        address,
        payload,
        true,
        {
          hasContent: Boolean(payload.content),
          hasReasoningChunk: Boolean(reasoningChunk),
          blockCount: blocks?.length ?? 0,
        },
      );
      handlers.onMessageAction({
        type: "assistant_chunk",
        subtaskId: identity.subtaskId,
        itemId: payload.itemId,
        content: payload.content,
        contentMode: payload.contentMode,
        offset: payload.offset,
        reasoningChunk,
        blocks,
      });
    },
    onChatDone: (payload) => {
      if (!isRuntimeTaskStreamPayload(address, payload)) {
        warnAndDropMismatchedRuntimeTerminalEvent(
          "chat:done",
          address,
          payload,
        );
        return;
      }
      const identity = runtimeStreamTaskSubtaskIdentity(payload);
      if (!identity) {
        warnAndDropRuntimeStreamEvent("chat:done", address, payload);
        return;
      }
      if (settledAssistantTurnIds.has(identity.subtaskId)) return;
      const blocks = getResultBlocks(identity.subtaskId, payload.result);
      const fileChanges =
        normalizeTurnFileChanges(payload.result.fileChanges) ??
        fileChangesFromBlocks(blocks) ??
        mergeTurnFileChanges([
          ...(streamedFileChanges.get(identity.subtaskId)?.values() ?? []),
        ]);
      streamedFileChanges.delete(identity.subtaskId);
      debugRuntimeStreamEvent(
        diagnostics,
        "chat:done",
        address,
        payload,
        true,
        {
          hasFileChanges: Boolean(fileChanges),
          blockCount: blocks?.length ?? 0,
        },
      );
      logAcceptedRuntimeTerminalEvent("chat:done", address, payload, {
        hasFileChanges: Boolean(fileChanges),
        blockCount: blocks?.length ?? 0,
      });
      if (payload.result.contextUsage) {
        handlers.onContextUsageUpdated?.(payload.result.contextUsage);
      }
      handlers.onMessageAction({
        type: "assistant_done",
        subtaskId: identity.subtaskId,
        turnId:
          typeof payload.result.turnId === "string"
            ? payload.result.turnId
            : typeof payload.result.turn_id === "string"
              ? payload.result.turn_id
              : undefined,
        itemId:
          typeof payload.result.itemId === "string"
            ? payload.result.itemId
            : typeof payload.result.item_id === "string"
              ? payload.result.item_id
              : undefined,
        ...(typeof payload.result.value === "string" &&
          payload.result.value.trim() && { content: payload.result.value }),
        blocks,
        fileChanges,
      });
      const assistantText =
        typeof payload.result?.value === "string" && payload.result.value.trim()
          ? payload.result.value
          : undefined;
      if (assistantText) {
        handlers.onAssistantResponseSize?.(
          identity.subtaskId,
          new TextEncoder().encode(assistantText).byteLength,
        );
      }
      settleAssistantTurn(identity.subtaskId, "succeeded");
    },
    onChatError: (payload) => {
      if (!isRuntimeTaskStreamPayload(address, payload)) {
        warnAndDropMismatchedRuntimeTerminalEvent(
          "chat:error",
          address,
          payload,
        );
        return;
      }
      const identity = runtimeStreamTaskSubtaskIdentity(payload);
      if (!identity) {
        warnAndDropRuntimeStreamEvent("chat:error", address, payload, {
          errorType: payload.type,
        });
        return;
      }
      debugRuntimeStreamEvent(
        diagnostics,
        "chat:error",
        address,
        payload,
        true,
        {
          error: payload.error,
          errorType: payload.type,
        },
      );
      logAcceptedRuntimeTerminalEvent("chat:error", address, payload, {
        errorType: payload.type ?? null,
      });
      const cancelled = isCancelledRuntimeError(payload);
      if (cancelled) {
        handlers.onMessageAction({
          type: "assistant_cancelled",
          subtaskId: identity.subtaskId,
        });
      } else {
        handlers.onMessageAction({
          type: "assistant_error",
          subtaskId: identity.subtaskId,
          error: payload.error,
          errorType: payload.type,
        });
      }
      settleAssistantTurn(
        identity.subtaskId,
        cancelled ? "cancelled" : "failed",
      );
      streamedFileChanges.delete(identity.subtaskId);
    },
    onBlockCreated: (payload) => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return;
      const identity = runtimeStreamTaskSubtaskIdentity(payload);
      if (!identity) {
        warnAndDropRuntimeStreamEvent("block:created", address, payload, {
          rawBlockType: isRecord(payload.block) ? payload.block.type : null,
        });
        return;
      }
      const block = normalizeChatBlock(identity.subtaskId, payload.block);
      debugRuntimeStreamEvent(
        diagnostics,
        "block:created",
        address,
        payload,
        true,
        {
          rawBlockType: isRecord(payload.block) ? payload.block.type : null,
          normalizedBlockType: block?.type ?? null,
        },
      );
      if (!block) return;
      if (block.type === "file_changes") {
        rememberStreamedFileChanges(
          streamedFileChanges,
          identity.subtaskId,
          block.id,
          block.fileChanges,
        );
      }
      handlers.onMessageAction({
        type: "block_created",
        subtaskId: identity.subtaskId,
        block,
        replaceAssistantTextItemId: payload.replacesItemId,
      });
      if (isStandaloneCompletedContextCompaction(identity.subtaskId, block)) {
        handlers.onMessageAction({
          type: "assistant_done",
          subtaskId: identity.subtaskId,
        });
        settleAssistantTurn(identity.subtaskId, "succeeded", false);
      }
    },
    onBlockUpdated: (payload) => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return;
      const identity = runtimeStreamTaskSubtaskIdentity(payload);
      if (!identity) {
        warnAndDropRuntimeStreamEvent("block:updated", address, payload, {
          blockId: payload.blockId,
          status: payload.status ?? null,
        });
        return;
      }
      debugRuntimeStreamEvent(
        diagnostics,
        "block:updated",
        address,
        payload,
        true,
        {
          blockId: payload.blockId,
          status: payload.status ?? null,
          hasContent: payload.content !== undefined,
          hasContentDelta: payload.contentDelta !== undefined,
          contentDeltaLength: payload.contentDelta?.length,
          hasToolInput: payload.toolInput !== undefined,
          hasToolOutput: payload.toolOutput !== undefined,
          hasToolOutputDelta: payload.toolOutputDelta !== undefined,
          hasToolOutputTruncated: payload.toolOutputTruncated !== undefined,
          hasRenderPayload: payload.renderPayload !== undefined,
          hasFileChanges: payload.fileChanges !== undefined,
          hasCompletedAt: payload.completedAt !== undefined,
          hasDurationMs: payload.durationMs !== undefined,
        },
      );
      const fileChanges = normalizeTurnFileChanges(payload.fileChanges);
      if (fileChanges) {
        rememberStreamedFileChanges(
          streamedFileChanges,
          identity.subtaskId,
          payload.blockId,
          fileChanges,
        );
      }
      handlers.onMessageAction({
        type: "block_updated",
        subtaskId: identity.subtaskId,
        blockId: payload.blockId,
        updates: {
          ...(payload.content !== undefined && { content: payload.content }),
          ...(payload.contentDelta !== undefined && {
            contentDelta: payload.contentDelta,
          }),
          ...(payload.toolInput !== undefined && {
            toolInput: payload.toolInput,
          }),
          ...(payload.toolOutput !== undefined && {
            toolOutput: payload.toolOutput,
          }),
          ...(payload.toolOutputDelta !== undefined && {
            toolOutputDelta: payload.toolOutputDelta,
          }),
          ...(payload.toolOutputTruncated !== undefined && {
            toolOutputTruncated: payload.toolOutputTruncated,
          }),
          ...(payload.renderPayload !== undefined && {
            renderPayload: payload.renderPayload,
          }),
          ...(payload.fileChanges !== undefined && {
            fileChanges: normalizeTurnFileChanges(payload.fileChanges),
          }),
          ...(payload.output !== undefined && { output: payload.output }),
          ...(payload.summary !== undefined && { summary: payload.summary }),
          ...(payload.parentToolUseId !== undefined && {
            parentToolUseId: payload.parentToolUseId,
          }),
          ...(payload.agentStatus !== undefined && {
            agentStatus: payload.agentStatus,
          }),
          ...(payload.status && {
            status: normalizeWorkbenchBlockStatus(payload.status),
          }),
          ...(payload.completedAt !== undefined && {
            completedAt: payload.completedAt,
          }),
          ...(payload.durationMs !== undefined && {
            durationMs: payload.durationMs,
          }),
        },
      });
    },
    onSubagentActivity: (payload) => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return;
      debugRuntimeStreamEvent(
        diagnostics,
        "subagent:activity",
        address,
        payload,
        true,
        {
          agentPath: payload.agentPath,
          status: payload.status ?? null,
          kind: payload.kind ?? null,
        },
      );
      handlers.onSubagentActivity?.(payload);
    },
    onRuntimeTaskTitleUpdated: (payload) => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return;
      handlers.onRuntimeTaskTitleUpdated?.(payload);
    },
    onRuntimeGoalUpdated: (payload) => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return;
      handlers.onRuntimeGoalUpdated?.(payload);
    },
    onRuntimeGoalCleared: (payload) => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return;
      handlers.onRuntimeGoalCleared?.(payload);
    },
    onRuntimeSupervisorUpdated: (payload) => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return;
      handlers.onRuntimeSupervisorUpdated?.(payload);
    },
    onRuntimeGoalContinuation: (payload) => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return;
      handlers.onRuntimeGoalContinuation?.(payload);
    },
    onRuntimePlanUpdated: (payload) => {
      const matched = isRuntimeTaskStreamPayload(address, payload);
      debugRuntimeStreamEvent(
        diagnostics,
        "plan:updated",
        address,
        payload,
        matched,
        {
          threadId: payload.threadId ?? null,
          turnId: payload.turnId ?? null,
          stepCount: payload.plan.length,
        },
      );
      if (diagnostics?.isDevelopment) {
        console.info("[Wework] Runtime task plan scoped", {
          matched,
          currentTaskId: address.taskId,
          eventTaskId: payload.taskId ?? null,
          stepCount: payload.plan.length,
        });
      }
      if (!matched) return;
      handlers.onRuntimePlanUpdated?.(payload);
    },
    onGuidanceApplied: (payload) => {
      if (!isRuntimeTaskStreamPayload(address, payload)) return;
      handlers.onGuidanceApplied?.(payload);
    },
    onRuntimeTransportReplaced: (payload) => {
      handlers.onRuntimeTransportReplaced?.(payload);
    },
  };
  return streamHandlers;
}
