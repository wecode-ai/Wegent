import {
  normalizeProcessingBlock,
  normalizeProcessingBlocks,
  isRecord,
} from "./runtime-transcript-blocks";

import type {
  ChatBlock,
  RuntimeTaskAddress,
  TurnFileChangesSummary,
} from "./runtime";
import type {
  ChatChunkPayload,
  ChatDonePayload,
  ChatErrorPayload,
  ChatStartPayload,
  ChatBlockCreatedPayload,
  ChatBlockUpdatedPayload,
  RuntimeGoalEventPayload,
  RuntimeSubagentActivityPayload,
} from "./runtime-stream-types";

import type { ProcessingBlock, WorkbenchMessage } from "./runtime-conversation";
import { mergeTurnFileChanges } from "./turn-file-changes";

export function isStandaloneCompletedContextCompaction(
  subtaskId: string,
  block: ProcessingBlock,
): boolean {
  return (
    isStandaloneContextCompactionSubtask(subtaskId) &&
    isCompletedContextCompactionBlock(block)
  );
}

export function isStandaloneContextCompactionSubtask(
  subtaskId: string,
): boolean {
  return subtaskId.endsWith("-context-compact");
}

export function isCompletedContextCompactionBlock(
  block: ProcessingBlock,
): boolean {
  if (block.type !== "tool" || block.status !== "done") return false;
  return normalizeToolName(block.toolName) === "contextcompaction";
}

export function normalizeToolName(toolName: string): string {
  return toolName.replace(/[\s_-]+/g, "").toLowerCase();
}

export function findFileChangesBySubtaskId(
  messages: WorkbenchMessage[],
  subtaskId: string,
): TurnFileChangesSummary | undefined {
  return messages.find(
    (message) =>
      message.subtaskId === subtaskId && message.fileChanges !== undefined,
  )?.fileChanges;
}

export function runtimeAddressDebug(
  address: RuntimeTaskAddress,
): Record<string, unknown> {
  return {
    deviceId: address.deviceId,
    taskId: address.taskId,
    workspacePath: address.workspacePath ?? null,
  };
}

export function runtimeTranscriptDebug(
  response: unknown,
): Record<string, unknown> {
  if (!isRecord(response)) {
    return {
      responseType: Array.isArray(response) ? "array" : typeof response,
    };
  }
  const messages = response.messages;
  return {
    keys: Object.keys(response).slice(0, 20),
    success: response.success,
    error: response.error,
    runtime: response.runtime,
    hasMessages: "messages" in response,
    messagesType: Array.isArray(messages) ? "array" : typeof messages,
    messageCount: Array.isArray(messages) ? messages.length : null,
    turnNavigationCount: Array.isArray(response.turnNavigation)
      ? response.turnNavigation.length
      : null,
    rangeStart: response.rangeStart,
    rangeEnd: response.rangeEnd,
    hasMoreBefore: response.hasMoreBefore,
    beforeCursor: response.beforeCursor,
    hasMoreAfter: response.hasMoreAfter,
    afterCursor: response.afterCursor,
  };
}

export function isRuntimeTaskStreamPayload(
  address: RuntimeTaskAddress,
  payload:
    | ChatStartPayload
    | ChatChunkPayload
    | ChatDonePayload
    | ChatErrorPayload
    | ChatBlockCreatedPayload
    | ChatBlockUpdatedPayload
    | RuntimeGoalEventPayload
    | RuntimeSubagentActivityPayload,
): boolean {
  if (typeof payload.taskId !== "string" || !payload.taskId.trim())
    return false;
  return (
    (!payload.deviceId || payload.deviceId === address.deviceId) &&
    payload.taskId === address.taskId
  );
}

export function runtimeStreamTaskSubtaskIdentity(
  payload:
    | ChatStartPayload
    | ChatChunkPayload
    | ChatDonePayload
    | ChatErrorPayload
    | ChatBlockCreatedPayload
    | ChatBlockUpdatedPayload
    | RuntimeSubagentActivityPayload,
): { taskId: string; subtaskId: string } | null {
  const taskId = payload.taskId;
  if (typeof taskId !== "string" || !taskId.trim()) return null;

  const subtaskId = payload.subtaskId;
  if (typeof subtaskId !== "string" || !subtaskId.trim()) {
    return null;
  }

  return { taskId, subtaskId };
}

export function warnAndDropRuntimeStreamEvent(
  event: string,
  address: RuntimeTaskAddress,
  payload: { taskId?: string; deviceId?: string; subtaskId?: string },
  details: Record<string, unknown> = {},
): void {
  console.warn("[Wework] Dropped runtime stream event without task identity", {
    event,
    address: runtimeAddressDebug(address),
    taskId: payload.taskId,
    deviceId: payload.deviceId,
    subtaskId: payload.subtaskId,
    ...details,
  });
}

export function warnAndDropMismatchedRuntimeTerminalEvent(
  event: "chat:done" | "chat:error",
  address: RuntimeTaskAddress,
  payload: { taskId?: string; deviceId?: string; subtaskId?: string },
): void {
  console.warn("[Wework] Dropped mismatched runtime terminal event", {
    event,
    currentRuntimeTask: runtimeAddressDebug(address),
    payloadTaskId: payload.taskId ?? null,
    payloadDeviceId: payload.deviceId ?? null,
    payloadSubtaskId: payload.subtaskId ?? null,
  });
}

export function logAcceptedRuntimeTerminalEvent(
  event: "chat:done" | "chat:error",
  address: RuntimeTaskAddress,
  payload: { taskId?: string; deviceId?: string; subtaskId?: string },
  details: Record<string, unknown>,
): void {
  console.info("[Wework] Runtime terminal event accepted", {
    event,
    currentRuntimeTask: runtimeAddressDebug(address),
    payloadTaskId: payload.taskId ?? null,
    payloadDeviceId: payload.deviceId ?? null,
    payloadSubtaskId: payload.subtaskId ?? null,
    ...details,
  });
}

export function warnAndDropEmptyRuntimeChunk(
  address: RuntimeTaskAddress,
  payload: ChatChunkPayload,
  details: Record<string, unknown> = {},
): void {
  console.warn("[Wework] Dropped empty runtime stream chunk", {
    event: "chat:chunk",
    address: runtimeAddressDebug(address),
    taskId: payload.taskId,
    deviceId: payload.deviceId,
    subtaskId: payload.subtaskId,
    hasContent: Boolean(payload.content),
    hasReasoningChunk: Boolean(getReasoningChunk(payload.result)),
    ...details,
  });
}

export function isCancelledRuntimeError(payload: ChatErrorPayload): boolean {
  const error = payload.error.trim().toLowerCase();
  const type = payload.type?.trim().toLowerCase();
  return (
    error === "interrupted" ||
    error === "cancelled" ||
    error === "canceled" ||
    error === "aborted" ||
    type === "interrupted" ||
    type === "cancelled" ||
    type === "canceled" ||
    type === "aborted"
  );
}

export function normalizeChatBlock(
  subtaskId: string,
  block: ChatBlock,
): ProcessingBlock | null {
  return normalizeProcessingBlock(subtaskId, block, 0);
}

export function getResultBlocks(
  subtaskId: string,
  result: unknown,
): ProcessingBlock[] | undefined {
  if (!isRecord(result) || !Array.isArray(result.blocks)) return undefined;
  const blocks = normalizeProcessingBlocks(subtaskId, result.blocks);
  return blocks.length > 0 ? blocks : undefined;
}

export function fileChangesFromBlocks(
  blocks: ProcessingBlock[] | undefined,
): TurnFileChangesSummary | undefined {
  return mergeTurnFileChanges(
    (blocks ?? []).flatMap((block) =>
      block.type === "file_changes" ? [block.fileChanges] : [],
    ),
  );
}

export function rememberStreamedFileChanges(
  summaries: Map<string, Map<string, TurnFileChangesSummary>>,
  subtaskId: string,
  blockId: string,
  fileChanges: TurnFileChangesSummary,
) {
  let blocks = summaries.get(subtaskId);
  if (!blocks) {
    blocks = new Map();
    summaries.set(subtaskId, blocks);
  }
  blocks.set(blockId, fileChanges);
}

export function getReasoningChunk(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  return typeof result.reasoningChunk === "string"
    ? result.reasoningChunk
    : undefined;
}

export interface RuntimeStreamDiagnostics {
  isEnabled(): boolean;
  isDevelopment?: boolean;
}

export function debugRuntimeStreamEvent(
  diagnostics: RuntimeStreamDiagnostics | undefined,
  label: string,
  address: RuntimeTaskAddress,
  payload: { taskId?: string; deviceId?: string; subtaskId?: string },
  matched: boolean,
  details: Record<string, unknown> = {},
) {
  if (!diagnostics?.isEnabled()) return;
  console.info(`[Wework runtime] ${label}`, {
    matched,
    currentRuntimeTask: runtimeAddressDebug(address),
    payloadDeviceId: payload.deviceId ?? null,
    payloadTaskId: payload.taskId ?? null,
    payloadSubtaskId: payload.subtaskId ?? null,
    ...details,
  });
}
