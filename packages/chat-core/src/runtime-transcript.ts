import type {
  RuntimeMessagePresentationReference,
  NormalizedRuntimeMessage,
  RuntimeTranscriptTurn,
} from "./runtime";
import type {
  MessageSource,
  RuntimeConversationItem,
  RuntimeConversationTurn,
  WorkbenchMessage,
} from "./runtime-conversation";
import { stripCodexUiDirectives } from "./codex-directives";
import { normalizeTurnFileChanges } from "./turn-file-changes";

import {
  normalizeProcessingBlock,
  getBlockTimestamp,
  normalizeProcessingBlocks,
  isRecord,
} from "./runtime-transcript-blocks";
const RUNTIME_MESSAGE_CONTENT_TRUNCATION_THRESHOLD_CHARS = 200_000;
export function runtimeMessagesToWorkbenchMessages(
  messages: NormalizedRuntimeMessage[],
): WorkbenchMessage[] {
  return messages.map(runtimeMessageToWorkbenchMessage);
}

export function runtimeTranscriptTurnsToConversationTurns(
  turns: RuntimeTranscriptTurn[],
): RuntimeConversationTurn[] {
  return turns.flatMap((turn) => {
    if (
      typeof turn.id !== "string" ||
      !turn.id.trim() ||
      !Array.isArray(turn.items)
    )
      return [];
    const fallbackTimestamp = runtimeTurnFallbackTimestamp(turn);
    const items: RuntimeConversationItem[] = [];
    for (const item of turn.items) {
      if (!item || typeof item.id !== "string" || !item.id.trim()) continue;
      switch (item.type) {
        case "user_message": {
          const message = runtimeMessageToWorkbenchMessage(item.message);
          if (message.role === "user") {
            items.push({
              id: item.id,
              type: "user_message",
              message: { ...message, role: "user" },
            });
          }
          break;
        }
        case "assistant_text": {
          if (typeof item.content === "string") {
            items.push({
              id: item.id,
              type: "assistant_text",
              content: stripCodexUiDirectives(item.content),
              createdAt: runtimeTimestampToIso(item.createdAt),
            });
          }
          break;
        }
        case "block": {
          const block = normalizeProcessingBlock(
            turn.id,
            item.block,
            0,
            fallbackTimestamp,
          );
          if (block) items.push({ id: item.id, type: "block", block });
          break;
        }
      }
    }
    const normalizedStatus = String(
      turn.runtimeStatus ?? turn.status ?? "",
    ).toLowerCase();
    const status: RuntimeConversationTurn["status"] =
      normalizedStatus === "cancelled"
        ? "cancelled"
        : normalizedStatus === "failed"
          ? "failed"
          : isRuntimeStreamingStatus(normalizedStatus)
            ? "streaming"
            : "done";
    return [
      {
        id: turn.id,
        clientUserMessageId: items.find((item) => item.type === "user_message")
          ?.message.id,
        runtimeMessageIndex:
          typeof turn.messageIndex === "number" ? turn.messageIndex : undefined,
        itemMerge: turn.itemMerge,
        items,
        status,
        completedAt: turn.completedAt,
        error: turn.error ?? undefined,
        errorType: turn.errorType ?? undefined,
        stoppedNotice: turn.stoppedNotice,
        fileChanges: normalizeTurnFileChanges(turn.fileChanges),
        references: turn.references ?? undefined,
        memoryCitations: turn.memoryCitations ?? undefined,
      },
    ];
  });
}

export function runtimeMessageToWorkbenchMessage(
  message: NormalizedRuntimeMessage,
): WorkbenchMessage {
  const role = message.role.toLowerCase() === "user" ? "user" : "assistant";
  const clientUserMessageId =
    message.clientUserMessageId ?? message.client_user_message_id ?? undefined;
  const subtaskId = runtimeMessageSubtaskId(message);
  const normalizedStatus = String(message.status ?? "").toLowerCase();
  const status: WorkbenchMessage["status"] =
    normalizedStatus === "failed"
      ? "failed"
      : isRuntimeStreamingStatus(normalizedStatus)
        ? "streaming"
        : "done";
  const runtimeStatus = normalizedStatus === "cancelled" ? "cancelled" : status;
  const source =
    role === "user" && message.source?.source === "im"
      ? ({ ...message.source, source: "im" } as MessageSource)
      : undefined;
  const createdAt = message.createdAt ?? new Date().toISOString();
  const completedAt = message.completedAt ?? message.completed_at ?? undefined;
  const stoppedNotice =
    message.stoppedNotice ?? message.stopped_notice ?? undefined;
  const runtimeMessageIndex =
    typeof message.messageIndex === "number"
      ? message.messageIndex
      : typeof message.message_index === "number"
        ? message.message_index
        : undefined;
  const messageCreatedAtMs = getBlockTimestamp(createdAt);
  warnInvalidRuntimeTranscriptIdentity(message, role, status, subtaskId);
  const blocks =
    typeof subtaskId === "string"
      ? normalizeProcessingBlocks(subtaskId, message.blocks, messageCreatedAtMs)
      : [];
  const contentTruncated = hasTruncatedRuntimeContent(message);
  const content =
    role === "assistant"
      ? stripCodexUiDirectives(message.content)
      : combineRuntimeUserMessagePresentation(
          message.content,
          message.presentationReferences ?? message.presentation_references,
        );
  return {
    id:
      role === "user" && clientUserMessageId ? clientUserMessageId : message.id,
    role,
    subtaskId,
    turnId: message.turnId ?? message.turn_id ?? undefined,
    content,
    contentTruncated: contentTruncated || undefined,
    contentOriginalChars: contentTruncated
      ? runtimeMessageOriginalChars(message)
      : undefined,
    runtimeMessageIndex,
    status,
    runtimeStatus,
    error: message.error ?? undefined,
    errorType: message.errorType ?? message.error_type ?? undefined,
    source,
    attachments: message.attachments,
    runtimeGoalRequest: normalizeRuntimeGoalRequest(message),
    blocks: blocks.length > 0 ? blocks : undefined,
    fileChanges: normalizeTurnFileChanges(
      message.fileChanges ?? message.file_changes,
    ),
    references: normalizeRuntimeReferences(message.references),
    memoryCitations: normalizeRuntimeMemoryCitations(message),
    createdAt,
    completedAt,
    stoppedNotice,
  };
}

export function runtimeTurnFallbackTimestamp(
  turn: RuntimeTranscriptTurn,
): number | undefined {
  for (const item of turn.items) {
    const value =
      item.type === "user_message"
        ? item.message.createdAt
        : item.type === "assistant_text"
          ? item.createdAt
          : (item.block.createdAt ??
            item.block.created_at ??
            item.block.timestamp);
    const timestamp =
      typeof value === "number" ? value : Date.parse(value ?? "");
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return undefined;
}

export function runtimeTimestampToIso(
  value: string | number | null | undefined,
): string {
  const timestamp = typeof value === "number" ? value : Date.parse(value ?? "");
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : new Date().toISOString();
}

export function isRuntimeStreamingStatus(status: string): boolean {
  return (
    status === "streaming" ||
    status === "running" ||
    status === "inprogress" ||
    status === "in_progress" ||
    status === "busy" ||
    status === "pending"
  );
}

export function runtimeMessageSubtaskId(
  message: NormalizedRuntimeMessage,
): string | undefined {
  const subtaskId = message.subtaskId;
  if (typeof subtaskId === "number") return String(subtaskId);
  return typeof subtaskId === "string" && subtaskId.trim()
    ? subtaskId
    : undefined;
}

export function warnInvalidRuntimeTranscriptIdentity(
  message: NormalizedRuntimeMessage,
  role: WorkbenchMessage["role"],
  status: WorkbenchMessage["status"],
  subtaskId: string | undefined,
): void {
  const hasBlocks = Array.isArray(message.blocks) && message.blocks.length > 0;
  const needsSubtaskId =
    role === "assistant" && (status === "streaming" || hasBlocks);
  if (!needsSubtaskId || typeof subtaskId === "string") return;

  console.warn(
    "[Wework] Runtime transcript message missing valid subtask identity",
    {
      messageId: message.id,
      role,
      status,
      subtaskId: message.subtaskId,
      blockCount: hasBlocks ? message.blocks?.length : 0,
    },
  );
}

export function hasTruncatedRuntimeContent(
  message: NormalizedRuntimeMessage,
): boolean {
  if (message.contentTruncated !== true && message.content_truncated !== true)
    return false;

  const originalChars = runtimeMessageOriginalChars(message);
  return (
    originalChars !== undefined &&
    originalChars > RUNTIME_MESSAGE_CONTENT_TRUNCATION_THRESHOLD_CHARS &&
    originalChars > runtimeContentCharacterCount(message.content)
  );
}

export function combineRuntimeUserMessagePresentation(
  content: string,
  references: RuntimeMessagePresentationReference[] | null | undefined,
): string {
  if (!references?.length) return content;

  const orderedReferences = [...references].sort(
    (left, right) => left.start - right.start,
  );
  const parts: string[] = [];
  let offset = 0;
  for (const reference of orderedReferences) {
    if (
      !Number.isInteger(reference.start) ||
      !Number.isInteger(reference.end) ||
      reference.start < offset ||
      reference.end <= reference.start ||
      reference.end > content.length ||
      !reference.href
    ) {
      continue;
    }
    parts.push(content.slice(offset, reference.start));
    parts.push(
      `[${content.slice(reference.start, reference.end)}](${reference.href})`,
    );
    offset = reference.end;
  }
  if (offset === 0) return content;
  parts.push(content.slice(offset));
  return parts.join("");
}

export function runtimeMessageOriginalChars(
  message: NormalizedRuntimeMessage,
): number | undefined {
  const originalChars =
    typeof message.contentOriginalChars === "number"
      ? message.contentOriginalChars
      : typeof message.content_original_chars === "number"
        ? message.content_original_chars
        : undefined;

  return originalChars !== undefined &&
    Number.isFinite(originalChars) &&
    originalChars >= 0
    ? originalChars
    : undefined;
}

export function normalizeRuntimeGoalRequest(
  message: NormalizedRuntimeMessage,
): boolean | undefined {
  return message.runtimeGoalRequest === true ||
    message.runtime_goal_request === true
    ? true
    : undefined;
}

export function normalizeRuntimeReferences(
  references: NormalizedRuntimeMessage["references"],
): WorkbenchMessage["references"] {
  if (!Array.isArray(references)) return undefined;
  const normalized = references.filter(
    (reference) =>
      reference && typeof reference.path === "string" && reference.path.trim(),
  );
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeRuntimeMemoryCitations(
  message: NormalizedRuntimeMessage,
): WorkbenchMessage["memoryCitations"] {
  const citations: NonNullable<WorkbenchMessage["memoryCitations"]> = [];
  const addCitation = (value: unknown) => {
    if (isRecord(value) && Array.isArray(value.entries)) {
      citations.push(
        value as NonNullable<WorkbenchMessage["memoryCitations"]>[number],
      );
    }
  };

  if (Array.isArray(message.memoryCitations)) {
    message.memoryCitations.forEach(addCitation);
  }
  if (Array.isArray(message.memory_citations)) {
    message.memory_citations.forEach(addCitation);
  }
  addCitation(message.memoryCitation);
  addCitation(message.memory_citation);

  return citations.length > 0 ? citations : undefined;
}

export function runtimeContentCharacterCount(content: string): number {
  return Array.from(content).length;
}
