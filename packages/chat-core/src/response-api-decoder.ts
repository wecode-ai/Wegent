import type {
  ChatBlock,
  RuntimeContextUsage,
  RuntimeTokenUsageBreakdown,
} from "./runtime";

import type { ChatStreamHandlers } from "./runtime-stream-types";

export const RESPONSE_API_STREAM_EVENTS = [
  "response.created",
  "response.in_progress",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "response.reasoning_summary_text.delta",
  "response.output_item.added",
  "response.output_item.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.refusal.delta",
  "response.refusal.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.mcp_call_arguments.delta",
  "response.mcp_call_arguments.done",
  "response.mcp_call.completed",
  "response.mcp_call.failed",
  "image_generation.partial_image",
  "response.block.created",
  "response.block.updated",
  "response.subagent.activity",
  "response.guidance.applied",
  "runtime.task.title.updated",
  "runtime.work.changed",
  "runtime.goal.updated",
  "runtime.goal.cleared",
  "runtime.goal.continuation",
  "runtime.supervisor.updated",
  "runtime.plan.updated",
  "thread/tokenUsage/updated",
  "thread.tokenUsage.updated",
  "error",
] as const;

export interface ResponseApiStreamState {
  toolContexts: Map<string, { name?: string; input?: Record<string, unknown> }>;
}

export const IMAGE_GENERATION_TOOL_NAME = "image_generation";

export function createResponseApiStreamState(): ResponseApiStreamState {
  return { toolContexts: new Map() };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function idField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function optionalNumberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

export function optionalFiniteNumberField(
  record: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function commandExitCode(
  record: Record<string, unknown>,
): number | undefined {
  return (
    optionalNumberField(record, "exit_code") ??
    optionalNumberField(record, "exitCode")
  );
}

export function recordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return asRecord(record[key]);
}

export function eventBase(payload: Record<string, unknown>) {
  const data = eventResult(payload);
  return {
    taskId: idField(payload, "taskId") ?? idField(data, "taskId"),
    subtaskId: idField(payload, "subtaskId") ?? idField(data, "subtaskId"),
    clientUserMessageId:
      idField(payload, "clientUserMessageId") ??
      idField(payload, "client_user_message_id") ??
      idField(data, "clientUserMessageId") ??
      idField(data, "client_user_message_id"),
    deviceId: stringField(payload, "deviceId") ?? stringField(data, "deviceId"),
  };
}

export function eventResult(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return asRecord(payload.data);
}

export function parseRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;

  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function eventContent(payload: Record<string, unknown>): string {
  const result = eventResult(payload);
  return stringField(result, "delta") ?? "";
}

export function eventOffset(
  payload: Record<string, unknown>,
): number | undefined {
  return (
    optionalNumberField(payload, "offset") ??
    optionalNumberField(eventResult(payload), "offset")
  );
}

export function completedContent(
  data: Record<string, unknown>,
): string | undefined {
  const explicit =
    stringField(data, "value") ?? stringField(data, "output_text");
  if (explicit) return explicit;

  const response = recordField(data, "response");
  const output = response.output;
  if (!Array.isArray(output)) return undefined;

  const parts = output.flatMap((item) => {
    const itemRecord = asRecord(item);
    const content = itemRecord.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) => {
      const partRecord = asRecord(part);
      if (partRecord.type !== "output_text") return [];
      const text = stringField(partRecord, "text");
      return text ? [text] : [];
    });
  });

  return parts.join("");
}

export function completedResult(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...data };
  const content = completedContent(data);
  if (content !== undefined) {
    result.value = content;
  }

  const response = recordField(data, "response");
  const fileChanges =
    response.file_changes ?? response.fileChanges ?? data.file_changes;
  if (
    typeof fileChanges === "object" &&
    fileChanges !== null &&
    !Array.isArray(fileChanges)
  ) {
    result.fileChanges = fileChanges;
  }
  const blocks = response.blocks ?? data.blocks;
  if (Array.isArray(blocks)) {
    result.blocks = blocks;
  }
  const contextUsage = contextUsageFromResponseData(data);
  if (contextUsage) {
    result.contextUsage = contextUsage;
  }

  return result;
}

export function normalizeTokenUsageBreakdown(
  value: Record<string, unknown> | undefined,
): RuntimeTokenUsageBreakdown | undefined {
  if (!value) return undefined;

  const inputTokens =
    optionalFiniteNumberField(value, "inputTokens", "input_tokens") ?? 0;
  const cachedInputTokens =
    optionalFiniteNumberField(
      value,
      "cachedInputTokens",
      "cached_input_tokens",
    ) ?? 0;
  const outputTokens =
    optionalFiniteNumberField(value, "outputTokens", "output_tokens") ?? 0;
  const reasoningOutputTokens =
    optionalFiniteNumberField(
      value,
      "reasoningOutputTokens",
      "reasoning_output_tokens",
    ) ?? 0;
  const totalTokens =
    optionalFiniteNumberField(value, "totalTokens", "total_tokens") ??
    inputTokens + outputTokens + reasoningOutputTokens;

  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
  };
}

export function normalizeContextUsage(
  value: Record<string, unknown> | undefined,
): RuntimeContextUsage | undefined {
  if (!value) return undefined;

  const modelContextWindow = optionalFiniteNumberField(
    value,
    "modelContextWindow",
    "model_context_window",
    "contextWindow",
    "context_window",
  );
  if (!modelContextWindow || modelContextWindow <= 0) return undefined;

  const total =
    normalizeTokenUsageBreakdown(recordField(value, "total")) ??
    normalizeTokenUsageBreakdown(recordField(value, "total_token_usage")) ??
    normalizeTokenUsageBreakdown(value);
  const last =
    normalizeTokenUsageBreakdown(recordField(value, "last")) ??
    normalizeTokenUsageBreakdown(recordField(value, "last_token_usage")) ??
    total;
  if (!total || !last) return undefined;

  return {
    total,
    last,
    modelContextWindow,
  };
}

export function contextUsageFromResponseData(
  data: Record<string, unknown>,
): RuntimeContextUsage | undefined {
  const direct =
    normalizeContextUsage(recordField(data, "contextUsage")) ??
    normalizeContextUsage(recordField(data, "context_usage")) ??
    normalizeContextUsage(recordField(data, "tokenUsage")) ??
    normalizeContextUsage(recordField(data, "token_usage"));
  if (direct) return direct;

  const response = recordField(data, "response");
  return (
    normalizeContextUsage(recordField(response, "contextUsage")) ??
    normalizeContextUsage(recordField(response, "context_usage")) ??
    normalizeContextUsage(recordField(response, "tokenUsage")) ??
    normalizeContextUsage(recordField(response, "token_usage"))
  );
}

export function callIdFromItem(
  item: Record<string, unknown>,
): string | undefined {
  return (
    stringField(item, "call_id") ??
    stringField(item, "callId") ??
    stringField(item, "id")
  );
}

export function callIdFromData(
  data: Record<string, unknown>,
): string | undefined {
  return (
    stringField(data, "call_id") ??
    stringField(data, "callId") ??
    stringField(data, "item_id")
  );
}

export function normalizeToolName(item: Record<string, unknown>): string {
  const itemType = stringField(item, "type");
  const rawName =
    stringField(item, "name") ??
    stringField(item, "server_label") ??
    (itemType === "shell_call" ? "bash" : undefined) ??
    (itemType === "mcp_call" ? "mcp" : "unknown");
  if (rawName === "exec_command") return "bash";
  if (rawName === "exec") return "bash";
  return rawName;
}

export function normalizeToolInput(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!input) return {};
  const normalized = { ...input };
  if ("cmd" in normalized && !("command" in normalized)) {
    normalized.command = normalized.cmd;
    delete normalized.cmd;
  }
  if ("commandLine" in normalized && !("command" in normalized)) {
    normalized.command = normalized.commandLine;
    delete normalized.commandLine;
  }
  if ("workdir" in normalized && !("cwd" in normalized)) {
    normalized.cwd = normalized.workdir;
    delete normalized.workdir;
  }
  return normalized;
}

export function toolInputFrom(
  data: Record<string, unknown>,
  item: Record<string, unknown>,
): Record<string, unknown> {
  const argumentsSummary = parseRecord(data.arguments_summary);
  if (argumentsSummary) return normalizeToolInput(argumentsSummary);

  const itemInput = parseRecord(item.input);
  if (itemInput) return normalizeToolInput(itemInput);

  const itemArguments = parseRecord(item.arguments);
  if (itemArguments) return normalizeToolInput(itemArguments);

  const dataArguments = parseRecord(data.arguments);
  if (dataArguments) return normalizeToolInput(dataArguments);

  const action = recordField(item, "action");
  const commands = action.commands;
  if (Array.isArray(commands)) {
    const command = commands
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    return command ? { command } : {};
  }

  return {};
}

export function responseToolItem(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return recordField(data, "item");
}

export function isToolItem(item: Record<string, unknown>): boolean {
  return [
    "function_call",
    "mcp_call",
    "shell_call",
    "image_generation_call",
  ].includes(stringField(item, "type") ?? "");
}

export function isCommandToolItem(item: Record<string, unknown>): boolean {
  return ["shell_call", "local_shell_call"].includes(
    stringField(item, "type") ?? "",
  );
}

export function toolStatusFromItem(
  item: Record<string, unknown>,
  fallback: ChatBlock["status"],
): ChatBlock["status"] {
  if (isCommandToolItem(item) && commandExitCode(item) !== undefined)
    return "done";
  const status = stringField(item, "status");
  return status === "error" || status === "failed" ? "error" : fallback;
}

export function emitBlockCreated(
  handlers: ChatStreamHandlers,
  base: ReturnType<typeof eventBase>,
  data: Record<string, unknown>,
  state: ResponseApiStreamState,
): void {
  const item = responseToolItem(data);
  if (!isToolItem(item)) {
    warnDroppedResponseBlock(
      "response.output_item.added",
      "not_tool_item",
      base,
      data,
    );
    return;
  }

  const callId = callIdFromItem(item);
  if (!callId) {
    warnDroppedResponseBlock(
      "response.output_item.added",
      "missing_call_id",
      base,
      data,
    );
    return;
  }

  const toolInput = toolInputFrom(data, item);
  const isImageGeneration = item.type === "image_generation_call";
  const toolName = isImageGeneration
    ? IMAGE_GENERATION_TOOL_NAME
    : normalizeToolName(item);
  state.toolContexts.set(callId, { name: toolName, input: toolInput });

  handlers.onBlockCreated?.({
    ...base,
    block: {
      id: callId,
      type: "tool",
      tool_use_id: callId,
      tool_name: toolName,
      tool_input: toolInput,
      ...(isImageGeneration && {
        renderPayload: imageGenerationRenderPayload(item),
      }),
      status:
        data.argument_status === "streaming"
          ? "generating_arguments"
          : "pending",
      timestamp: Date.now(),
    },
  });
}

export function emitBlockUpdated(
  handlers: ChatStreamHandlers,
  eventName: string,
  base: ReturnType<typeof eventBase>,
  blockId: string | undefined,
  updates: {
    status?: ChatBlock["status"] | "running";
    toolInput?: Record<string, unknown>;
    toolOutput?: unknown;
    toolOutputDelta?: string;
    toolOutputTruncated?: boolean;
    toolOutputOriginalBytes?: number;
    content?: string;
    contentDelta?: string;
    fileChanges?: ChatBlock["fileChanges"];
    renderPayload?: unknown;
  },
): void {
  if (!blockId) {
    warnDroppedResponseBlock(eventName, "missing_block_id", base, { updates });
    return;
  }
  handlers.onBlockUpdated?.({
    ...base,
    blockId,
    ...updates,
  });
}

export function emitToolArgumentsUpdate(
  handlers: ChatStreamHandlers,
  base: ReturnType<typeof eventBase>,
  data: Record<string, unknown>,
  state: ResponseApiStreamState,
  status: ChatBlock["status"],
): void {
  const callId = callIdFromData(data);
  if (!callId) return;

  const toolInput = toolInputFrom(data, {});
  const previous = state.toolContexts.get(callId) ?? {};
  const nextInput =
    Object.keys(toolInput).length > 0 ? toolInput : previous.input;
  state.toolContexts.set(callId, { ...previous, input: nextInput });

  emitBlockUpdated(handlers, "response.function_call_arguments", base, callId, {
    status,
    ...(nextInput && { toolInput: nextInput }),
  });
}

export function emitToolDone(
  handlers: ChatStreamHandlers,
  base: ReturnType<typeof eventBase>,
  data: Record<string, unknown>,
  state: ResponseApiStreamState,
): void {
  const item = responseToolItem(data);
  const callId = callIdFromItem(item) ?? callIdFromData(data);
  if (!callId) return;

  const previous = state.toolContexts.get(callId);
  const toolInput = toolInputFrom(data, item);
  const nextInput =
    Object.keys(toolInput).length > 0 ? toolInput : previous?.input;
  const toolOutput = item.output ?? data.output ?? data.failure_reason;
  const status = toolStatusFromItem(
    item,
    data.failure_reason ? "error" : "done",
  );

  emitBlockUpdated(handlers, "response.output_item.done", base, callId, {
    status,
    ...(nextInput && { toolInput: nextInput }),
    ...(toolOutput !== undefined && { toolOutput }),
    ...(item.type === "image_generation_call" && {
      renderPayload: imageGenerationRenderPayload(item),
    }),
  });

  state.toolContexts.delete(callId);
}

export function imageGenerationRenderPayload(
  item: Record<string, unknown>,
): Record<string, unknown> {
  const result = stringField(item, "result");
  const partialImage = stringField(item, "partial_image_b64");
  const imageBase64 = result ?? partialImage;
  const revisedPrompt =
    stringField(item, "revised_prompt") ?? stringField(item, "revisedPrompt");
  const savedPath =
    stringField(item, "saved_path") ?? stringField(item, "savedPath");

  return {
    kind: "image_generation",
    ...(imageBase64 && { imageBase64 }),
    ...(revisedPrompt && { revisedPrompt }),
    ...(savedPath && { savedPath }),
  };
}

export function emitImageGenerationPartial(
  handlers: ChatStreamHandlers,
  base: ReturnType<typeof eventBase>,
  data: Record<string, unknown>,
): void {
  const blockId = callIdFromData(data) ?? stringField(data, "id");
  const partialImage = stringField(data, "partial_image_b64");
  if (!blockId || !partialImage) {
    warnDroppedResponseBlock(
      "image_generation.partial_image",
      "missing_image_data",
      base,
      data,
    );
    return;
  }
  emitBlockUpdated(handlers, "image_generation.partial_image", base, blockId, {
    status: "streaming",
    renderPayload: imageGenerationRenderPayload(data),
  });
}

export function emitResponseBlockCreated(
  handlers: ChatStreamHandlers,
  base: ReturnType<typeof eventBase>,
  data: Record<string, unknown>,
): void {
  const block = data.block;
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    warnDroppedResponseBlock(
      "response.block.created",
      "invalid_block",
      base,
      data,
    );
    return;
  }
  handlers.onBlockCreated?.({
    ...base,
    block: block as ChatBlock,
    ...(stringField(data, "replacesItemId") && {
      replacesItemId: stringField(data, "replacesItemId"),
    }),
  });
}

export function emitResponseBlockUpdated(
  handlers: ChatStreamHandlers,
  base: ReturnType<typeof eventBase>,
  data: Record<string, unknown>,
): void {
  const block = data.block;
  if (typeof block === "object" && block !== null && !Array.isArray(block)) {
    handlers.onBlockCreated?.({
      ...base,
      block: block as ChatBlock,
    });
  }
  const updates = recordField(data, "updates");
  const toolInput = parseRecord(updates.toolInput ?? updates.tool_input);
  const renderPayload = updates.renderPayload ?? updates.render_payload;
  const fileChanges = parseRecord(updates.fileChanges ?? updates.file_changes);
  const contentDelta = updates.contentDelta ?? updates.content_delta;
  const toolOutputDelta = updates.toolOutputDelta ?? updates.tool_output_delta;
  const toolOutputTruncated =
    updates.toolOutputTruncated ?? updates.tool_output_truncated;
  const toolOutputOriginalBytes =
    updates.toolOutputOriginalBytes ?? updates.tool_output_original_bytes;
  const parentToolUseId =
    stringField(updates, "parentToolUseId") ??
    stringField(updates, "parent_tool_use_id");
  const agentStatus =
    updates.agentStatus === "running" ||
    updates.agentStatus === "done" ||
    updates.agentStatus === "interrupted"
      ? updates.agentStatus
      : updates.agent_status === "running" ||
          updates.agent_status === "done" ||
          updates.agent_status === "interrupted"
        ? updates.agent_status
        : undefined;
  const completedAt =
    optionalNumberField(updates, "completedAt") ??
    optionalNumberField(updates, "completed_at");
  const durationMs =
    optionalNumberField(updates, "durationMs") ??
    optionalNumberField(updates, "duration_ms");
  emitBlockUpdated(
    handlers,
    "response.block.updated",
    base,
    stringField(data, "blockId") ?? stringField(data, "block_id"),
    {
      ...(typeof updates.content === "string" && { content: updates.content }),
      ...(typeof contentDelta === "string" && { contentDelta }),
      ...(typeof (updates.toolOutput ?? updates.tool_output) !==
        "undefined" && {
        toolOutput: updates.toolOutput ?? updates.tool_output,
      }),
      ...(typeof toolOutputDelta === "string" && {
        toolOutputDelta,
      }),
      ...(typeof toolOutputTruncated === "boolean" && {
        toolOutputTruncated,
      }),
      ...(typeof toolOutputOriginalBytes === "number" && {
        toolOutputOriginalBytes,
      }),
      ...(toolInput && { toolInput }),
      ...(renderPayload !== undefined && { renderPayload }),
      ...(fileChanges && {
        fileChanges: fileChanges as unknown as ChatBlock["fileChanges"],
      }),
      ...(typeof updates.output === "string" && { output: updates.output }),
      ...(typeof updates.summary === "string" && { summary: updates.summary }),
      ...(parentToolUseId && { parentToolUseId }),
      ...(agentStatus && { agentStatus }),
      ...(typeof updates.status === "string" && {
        status: updates.status as ChatBlock["status"],
      }),
      ...(completedAt !== undefined && { completedAt }),
      ...(durationMs !== undefined && { durationMs }),
    },
  );
}

export function warnDroppedResponseBlock(
  event: string,
  reason: string,
  base: ReturnType<typeof eventBase>,
  data: Record<string, unknown>,
): void {
  console.warn("[Wework] Dropped response block event", {
    event,
    reason,
    taskId: base.taskId,
    subtaskId: base.subtaskId,
    deviceId: base.deviceId,
    dataKeys: Object.keys(data).sort(),
    blockId: stringField(data, "blockId") ?? stringField(data, "block_id"),
    itemType: stringField(recordField(data, "item"), "type"),
  });
}

export function warnDroppedResponseDelta(
  event: string,
  reason: string,
  base: ReturnType<typeof eventBase>,
  data: Record<string, unknown>,
): void {
  console.warn("[Wework] Dropped response delta event", {
    event,
    reason,
    taskId: base.taskId,
    subtaskId: base.subtaskId,
    deviceId: base.deviceId,
    dataKeys: Object.keys(data).sort(),
  });
}

export function emitSubagentActivity(
  handlers: ChatStreamHandlers,
  base: ReturnType<typeof eventBase>,
  data: Record<string, unknown>,
): void {
  const agentPath =
    stringField(data, "agent_path") ?? stringField(data, "agentPath");
  if (!agentPath) return;

  handlers.onSubagentActivity?.({
    ...base,
    agentPath,
    agentName:
      stringField(data, "agent_name") ?? stringField(data, "agentName"),
    agentThreadId:
      stringField(data, "agent_thread_id") ??
      stringField(data, "agentThreadId"),
    kind: stringField(data, "kind"),
    status: stringField(data, "status"),
    occurredAtMs:
      optionalNumberField(data, "occurred_at_ms") ??
      optionalNumberField(data, "occurredAtMs"),
  });
}

export function errorMessage(
  payload: Record<string, unknown>,
  data: Record<string, unknown>,
): string {
  const error = data.error;
  if (typeof error === "string") return error;
  const errorRecord = asRecord(error);
  return (
    stringField(payload, "error") ??
    stringField(data, "message") ??
    stringField(errorRecord, "message") ??
    eventContent(payload) ??
    "Response stream error"
  );
}
