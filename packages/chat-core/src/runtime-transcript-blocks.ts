import type { ProcessingBlock } from "./runtime-conversation";

import { normalizeTurnFileChanges } from "./turn-file-changes";
import { normalizeWorkbenchBlockStatus } from "./workbench-message-reducer";

export function normalizeProcessingBlock(
  subtaskId: string,
  block: unknown,
  index: number,
  fallbackTimestamp?: number,
): ProcessingBlock | null {
  if (!isRecord(block)) return null;

  const timestamp = getBlockTimestamp(
    block.timestamp ?? block.created_at ?? block.createdAt,
    fallbackTimestamp,
  );
  const explicitCompletedAt = block.completedAt ?? block.completed_at;
  const durationMs =
    typeof block.durationMs === "number" && Number.isFinite(block.durationMs)
      ? Math.max(0, block.durationMs)
      : typeof block.duration_ms === "number" &&
          Number.isFinite(block.duration_ms)
        ? Math.max(0, block.duration_ms)
        : undefined;
  const completedAt =
    durationMs !== undefined
      ? timestamp + durationMs
      : explicitCompletedAt !== undefined
        ? getBlockTimestamp(explicitCompletedAt, timestamp)
        : undefined;
  const status = normalizeWorkbenchBlockStatus(
    typeof block.status === "string" ? block.status : undefined,
  );
  const timing = {
    status,
    createdAt: timestamp,
    completedAt,
    ...(durationMs !== undefined && { durationMs }),
  };
  const parentToolUseId =
    typeof block.parentToolUseId === "string"
      ? block.parentToolUseId
      : typeof block.parent_tool_use_id === "string"
        ? block.parent_tool_use_id
        : undefined;
  if (block.type === "tool") {
    const id =
      typeof block.id === "string"
        ? block.id
        : typeof block.tool_use_id === "string"
          ? block.tool_use_id
          : typeof block.toolUseId === "string"
            ? block.toolUseId
            : null;
    if (!id) return warnAndDropRuntimeTranscriptBlock(subtaskId, block, index);
    return {
      id,
      subtaskId,
      type: "tool",
      toolName:
        typeof block.toolName === "string"
          ? block.toolName
          : typeof block.tool_name === "string"
            ? block.tool_name
            : "unknown",
      toolInput: isRecord(block.toolInput)
        ? block.toolInput
        : isRecord(block.tool_input)
          ? block.tool_input
          : undefined,
      toolOutput: block.toolOutput ?? block.tool_output,
      toolOutputTruncated:
        typeof block.toolOutputTruncated === "boolean"
          ? block.toolOutputTruncated
          : typeof block.tool_output_truncated === "boolean"
            ? block.tool_output_truncated
            : undefined,
      toolOutputOriginalBytes:
        typeof block.toolOutputOriginalBytes === "number"
          ? block.toolOutputOriginalBytes
          : typeof block.tool_output_original_bytes === "number"
            ? block.tool_output_original_bytes
            : undefined,
      renderPayload: normalizeToolRenderPayload(block),
      ...(parentToolUseId && { parentToolUseId }),
      ...timing,
    };
  }

  if (block.type === "image_generation_call") {
    const id = typeof block.id === "string" ? block.id : null;
    if (!id) return warnAndDropRuntimeTranscriptBlock(subtaskId, block, index);
    return {
      id,
      subtaskId,
      type: "tool",
      toolName: "image_generation",
      renderPayload: {
        kind: "image_generation",
        ...(typeof block.result === "string" && { imageBase64: block.result }),
        ...(typeof block.revised_prompt === "string" && {
          revisedPrompt: block.revised_prompt,
        }),
        ...(typeof block.saved_path === "string" && {
          savedPath: block.saved_path,
        }),
      },
      ...(parentToolUseId && { parentToolUseId }),
      ...timing,
    };
  }

  if (block.type === "thinking") {
    const id = typeof block.id === "string" ? block.id : null;
    if (!id) return warnAndDropRuntimeTranscriptBlock(subtaskId, block, index);
    return {
      id,
      subtaskId,
      type: "thinking",
      content: typeof block.content === "string" ? block.content : "",
      contentTruncated:
        typeof block.contentTruncated === "boolean"
          ? block.contentTruncated
          : typeof block.content_truncated === "boolean"
            ? block.content_truncated
            : undefined,
      contentOriginalChars:
        typeof block.contentOriginalChars === "number"
          ? block.contentOriginalChars
          : typeof block.content_original_chars === "number"
            ? block.content_original_chars
            : undefined,
      ...(parentToolUseId && { parentToolUseId }),
      ...timing,
    };
  }

  if (block.type === "text") {
    const id = typeof block.id === "string" ? block.id : null;
    if (!id) return warnAndDropRuntimeTranscriptBlock(subtaskId, block, index);
    const content =
      typeof block.content === "string"
        ? block.content
        : typeof block.text === "string"
          ? block.text
          : "";
    return {
      id,
      subtaskId,
      type: "text",
      content,
      contentTruncated:
        typeof block.contentTruncated === "boolean"
          ? block.contentTruncated
          : typeof block.content_truncated === "boolean"
            ? block.content_truncated
            : undefined,
      contentOriginalChars:
        typeof block.contentOriginalChars === "number"
          ? block.contentOriginalChars
          : typeof block.content_original_chars === "number"
            ? block.content_original_chars
            : undefined,
      ...(parentToolUseId && { parentToolUseId }),
      ...timing,
    };
  }

  if (block.type === "plan") {
    const id = typeof block.id === "string" ? block.id : null;
    if (!id) return warnAndDropRuntimeTranscriptBlock(subtaskId, block, index);
    const content =
      typeof block.content === "string"
        ? block.content
        : typeof block.text === "string"
          ? block.text
          : "";
    return {
      id,
      subtaskId,
      type: "plan",
      content,
      contentTruncated:
        typeof block.contentTruncated === "boolean"
          ? block.contentTruncated
          : typeof block.content_truncated === "boolean"
            ? block.content_truncated
            : undefined,
      contentOriginalChars:
        typeof block.contentOriginalChars === "number"
          ? block.contentOriginalChars
          : typeof block.content_original_chars === "number"
            ? block.content_original_chars
            : undefined,
      ...(parentToolUseId && { parentToolUseId }),
      ...timing,
    };
  }

  if (block.type === "subagent") {
    const id =
      typeof block.id === "string"
        ? block.id
        : typeof block.tool_use_id === "string"
          ? block.tool_use_id
          : null;
    if (!id) return warnAndDropRuntimeTranscriptBlock(subtaskId, block, index);
    const children = Array.isArray(block.children)
      ? normalizeProcessingBlocks(subtaskId, block.children, timestamp)
      : undefined;
    return {
      id,
      subtaskId,
      type: "subagent",
      toolName:
        typeof block.toolName === "string"
          ? block.toolName
          : typeof block.tool_name === "string"
            ? block.tool_name
            : undefined,
      agentType:
        typeof block.agentType === "string"
          ? block.agentType
          : typeof block.agent_type === "string"
            ? block.agent_type
            : undefined,
      agentId:
        typeof block.agentId === "string"
          ? block.agentId
          : typeof block.agent_id === "string"
            ? block.agent_id
            : undefined,
      agentThreadId:
        typeof block.agentThreadId === "string"
          ? block.agentThreadId
          : typeof block.agent_thread_id === "string"
            ? block.agent_thread_id
            : undefined,
      agentPath:
        typeof block.agentPath === "string"
          ? block.agentPath
          : typeof block.agent_path === "string"
            ? block.agent_path
            : undefined,
      agentStatus:
        block.agentStatus === "running" ||
        block.agentStatus === "done" ||
        block.agentStatus === "interrupted"
          ? block.agentStatus
          : block.agent_status === "running" ||
              block.agent_status === "done" ||
              block.agent_status === "interrupted"
            ? block.agent_status
            : undefined,
      title: typeof block.title === "string" ? block.title : undefined,
      description:
        typeof block.description === "string" ? block.description : undefined,
      output: typeof block.output === "string" ? block.output : undefined,
      summary: typeof block.summary === "string" ? block.summary : undefined,
      ...(children?.length && { children }),
      ...(parentToolUseId && { parentToolUseId }),
      ...timing,
    };
  }

  if (block.type === "file_changes") {
    const fileChanges = normalizeTurnFileChanges(
      block.fileChanges ?? block.file_changes,
    );
    if (!fileChanges) return null;
    const id = typeof block.id === "string" ? block.id : null;
    if (!id) return warnAndDropRuntimeTranscriptBlock(subtaskId, block, index);
    return {
      id,
      subtaskId,
      type: "file_changes",
      fileChanges,
      ...(parentToolUseId && { parentToolUseId }),
      ...timing,
    };
  }

  console.warn("[Wework] Dropped runtime block with unsupported type", {
    subtaskId,
    index,
    blockType: block.type,
    blockId: block.id,
    blockKeys: Object.keys(block).sort(),
  });
  return null;
}

export function getBlockTimestamp(
  value: unknown,
  fallbackTimestamp = Date.now(),
): number {
  if (typeof value === "string" && value.trim()) {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) {
      return getBlockTimestamp(numericValue, fallbackTimestamp);
    }

    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : fallbackTimestamp;
  }

  if (typeof value !== "number" || !Number.isFinite(value))
    return fallbackTimestamp;

  if (value > 1_000_000_000_000) return value;
  if (value > 1_000_000_000) return value * 1000;
  return fallbackTimestamp;
}

export function normalizeProcessingBlocks(
  subtaskId: string,
  blocks?: unknown[],
  fallbackTimestamp?: number,
): ProcessingBlock[] {
  if (!blocks) return [];

  return blocks.flatMap((block, index) => {
    const normalized = normalizeProcessingBlock(
      subtaskId,
      block,
      index,
      fallbackTimestamp,
    );
    return normalized ? [normalized] : [];
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function warnAndDropRuntimeTranscriptBlock(
  subtaskId: string,
  block: Record<string, unknown>,
  index: number,
): null {
  console.warn(
    "[Wework] Dropped runtime transcript block without block identity",
    {
      subtaskId,
      index,
      blockType: block.type,
      blockId: block.id,
      toolUseId: block.tool_use_id,
    },
  );
  return null;
}

export function normalizeToolRenderPayload(
  block: Record<string, unknown>,
): unknown {
  const payload = block.renderPayload ?? block.render_payload;
  const response =
    block.requestUserInputResponse ?? block.request_user_input_response;
  if (!isRecord(payload) || response === undefined) return payload;
  if (payload.kind !== "request_user_input") return payload;
  return {
    ...payload,
    response,
  };
}
