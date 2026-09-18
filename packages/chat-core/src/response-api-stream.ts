import type {
  RuntimeGoal,
  RuntimeGoalContinuationPayload,
  RuntimeSupervisorState,
  RuntimeTaskTitleUpdatedPayload,
} from "./runtime-stream-types";

import type { ChatStreamHandlers } from "./runtime-stream-types";

import {
  type ResponseApiStreamState,
  asRecord,
  stringField,
  idField,
  optionalNumberField,
  recordField,
  eventBase,
  eventResult,
  eventContent,
  eventOffset,
  completedResult,
  normalizeContextUsage,
  contextUsageFromResponseData,
  emitBlockCreated,
  emitToolArgumentsUpdate,
  emitToolDone,
  emitImageGenerationPartial,
  emitResponseBlockCreated,
  emitResponseBlockUpdated,
  warnDroppedResponseDelta,
  emitSubagentActivity,
  errorMessage,
} from "./response-api-decoder";
export {
  createResponseApiStreamState,
  RESPONSE_API_STREAM_EVENTS,
} from "./response-api-decoder";
export type { ResponseApiStreamState } from "./response-api-decoder";
export function emitResponseApiEvent(
  handlers: ChatStreamHandlers,
  eventName: string,
  rawPayload: unknown,
  state: ResponseApiStreamState,
  diagnostics?: { isDevelopment?: boolean },
): void {
  const payload = asRecord(rawPayload);
  const base = eventBase(payload);
  const data = eventResult(payload);

  if (
    eventName === "response.created" ||
    eventName === "response.in_progress"
  ) {
    if (eventName === "response.created") state.toolContexts.clear();
    const generatedUserMessage = asRecord(payload.runtimeGeneratedUserMessage);
    const generatedUserMessageId = stringField(generatedUserMessage, "id");
    const generatedUserMessageContent = stringField(
      generatedUserMessage,
      "message",
    );
    handlers.onChatStart?.({
      ...base,
      shellType: stringField(payload, "runtime"),
      ...(generatedUserMessageId &&
        generatedUserMessageContent && {
          runtimeGeneratedUserMessage: {
            id: generatedUserMessageId,
            message: generatedUserMessageContent,
            createdAt:
              optionalNumberField(generatedUserMessage, "createdAt") ??
              Date.now(),
            source: asRecord(generatedUserMessage.source),
          },
        }),
    });
    return;
  }

  if (
    eventName === "response.output_text.delta" ||
    eventName === "response.refusal.delta"
  ) {
    const content = eventContent(payload);
    if (!content) {
      warnDroppedResponseDelta(eventName, "empty_text_delta", base, data);
      return;
    }
    handlers.onChatChunk?.({
      ...base,
      itemId: idField(data, "itemId") ?? idField(data, "item_id"),
      content,
      ...(eventOffset(payload) !== undefined && {
        offset: eventOffset(payload),
      }),
      result: eventResult(payload),
    });
    return;
  }

  if (
    eventName === "response.output_text.done" ||
    eventName === "response.refusal.done"
  ) {
    const content =
      stringField(data, "text") ??
      stringField(data, "value") ??
      stringField(data, "output_text") ??
      stringField(data, "refusal");
    const itemId = idField(data, "itemId") ?? idField(data, "item_id");
    if (!content || !itemId) {
      warnDroppedResponseDelta(
        eventName,
        "missing_completed_text_identity",
        base,
        data,
      );
      return;
    }
    handlers.onChatChunk?.({
      ...base,
      itemId,
      content,
      contentMode: "snapshot",
      result: data,
    });
    return;
  }

  if (eventName === "response.reasoning_summary_text.delta") {
    const content = stringField(data, "delta") ?? "";
    if (!content) {
      warnDroppedResponseDelta(eventName, "empty_reasoning_delta", base, data);
      return;
    }
    handlers.onChatChunk?.({
      ...base,
      content: "",
      ...(eventOffset(payload) !== undefined && {
        offset: eventOffset(payload),
      }),
      result: { reasoningChunk: content },
    });
    return;
  }

  if (eventName === "response.block.created") {
    emitResponseBlockCreated(handlers, base, data);
    return;
  }

  if (eventName === "response.block.updated") {
    emitResponseBlockUpdated(handlers, base, data);
    return;
  }

  if (eventName === "response.subagent.activity") {
    emitSubagentActivity(handlers, base, data);
    return;
  }

  if (eventName === "response.guidance.applied") {
    handlers.onGuidanceApplied?.({
      ...base,
      guidanceId:
        stringField(data, "guidanceId") ??
        stringField(data, "guidance_id") ??
        "guidance",
      clientGuidanceId:
        stringField(data, "clientGuidanceId") ??
        stringField(data, "client_guidance_id"),
      message: stringField(data, "message") ?? "",
      appliedAtMs:
        optionalNumberField(data, "appliedAtMs") ??
        optionalNumberField(data, "applied_at_ms") ??
        Date.now(),
    });
    return;
  }

  if (eventName === "runtime.task.title.updated") {
    const title = stringField(data, "title");
    if (!title) return;
    handlers.onRuntimeTaskTitleUpdated?.({
      ...base,
      title,
    } as RuntimeTaskTitleUpdatedPayload);
    return;
  }

  if (eventName === "runtime.work.changed") {
    const taskId = base.taskId;
    if (!taskId) return;
    handlers.onRuntimeWorkChanged?.({
      taskId,
      ...(base.deviceId ? { deviceId: base.deviceId } : {}),
    });
    return;
  }

  if (eventName === "runtime.goal.updated") {
    handlers.onRuntimeGoalUpdated?.({
      ...base,
      threadId: stringField(data, "thread_id") ?? stringField(data, "threadId"),
      turnId: stringField(data, "turn_id") ?? stringField(data, "turnId"),
      goal: (data.goal ?? null) as RuntimeGoal | null,
    });
    return;
  }

  if (eventName === "runtime.goal.cleared") {
    handlers.onRuntimeGoalCleared?.({
      ...base,
      threadId: stringField(data, "thread_id") ?? stringField(data, "threadId"),
      goal: null,
    });
    return;
  }

  if (eventName === "runtime.supervisor.updated") {
    handlers.onRuntimeSupervisorUpdated?.({
      ...base,
      supervisor: (data.supervisor ?? null) as RuntimeSupervisorState | null,
    });
    return;
  }

  if (eventName === "runtime.goal.continuation") {
    const status = stringField(data, "status");
    if (status !== "started" && status !== "settled") return;
    handlers.onRuntimeGoalContinuation?.({
      ...base,
      threadId: stringField(data, "thread_id") ?? stringField(data, "threadId"),
      turnId: stringField(data, "turn_id") ?? stringField(data, "turnId"),
      status,
    } as RuntimeGoalContinuationPayload);
    return;
  }

  if (eventName === "runtime.plan.updated") {
    const plan = data.plan;
    if (!Array.isArray(plan)) return;
    const normalizedPlan = plan.flatMap((item) => {
      const step = asRecord(item);
      const text = stringField(step, "step");
      const status = stringField(step, "status");
      if (
        !text ||
        !["pending", "inProgress", "completed"].includes(status ?? "")
      )
        return [];
      return [
        {
          step: text,
          status: status as "pending" | "inProgress" | "completed",
        },
      ];
    });
    const payload = {
      ...base,
      threadId: stringField(data, "threadId") ?? stringField(data, "thread_id"),
      turnId: stringField(data, "turnId") ?? stringField(data, "turn_id"),
      explanation: stringField(data, "explanation"),
      plan: normalizedPlan,
    };
    if (diagnostics?.isDevelopment) {
      console.warn("[Wework] Runtime task plan parsed", {
        taskId: payload.taskId ?? null,
        deviceId: payload.deviceId ?? null,
        threadId: payload.threadId ?? null,
        stepCount: payload.plan.length,
      });
    }
    handlers.onRuntimePlanUpdated?.(payload);
    return;
  }

  if (
    eventName === "thread/tokenUsage/updated" ||
    eventName === "thread.tokenUsage.updated"
  ) {
    const contextUsage =
      normalizeContextUsage(recordField(data, "tokenUsage")) ??
      normalizeContextUsage(recordField(data, "token_usage")) ??
      contextUsageFromResponseData(data);
    if (!contextUsage) return;

    handlers.onChatChunk?.({
      ...base,
      content: "",
      result: { contextUsage },
    });
    return;
  }

  if (eventName === "response.output_item.added") {
    emitBlockCreated(handlers, base, data, state);
    return;
  }

  if (eventName === "image_generation.partial_image") {
    emitImageGenerationPartial(handlers, base, data);
    return;
  }

  if (
    eventName === "response.function_call_arguments.delta" ||
    eventName === "response.mcp_call_arguments.delta"
  ) {
    emitToolArgumentsUpdate(
      handlers,
      base,
      data,
      state,
      "generating_arguments",
    );
    return;
  }

  if (
    eventName === "response.function_call_arguments.done" ||
    eventName === "response.mcp_call_arguments.done"
  ) {
    emitToolArgumentsUpdate(handlers, base, data, state, "pending");
    return;
  }

  if (
    eventName === "response.output_item.done" ||
    eventName === "response.mcp_call.completed" ||
    eventName === "response.mcp_call.failed"
  ) {
    emitToolDone(handlers, base, data, state);
    return;
  }

  if (eventName === "response.completed") {
    state.toolContexts.clear();
    handlers.onChatDone?.({
      ...base,
      ...(eventOffset(payload) !== undefined && {
        offset: eventOffset(payload),
      }),
      result: completedResult(data),
    });
    return;
  }

  if (
    eventName === "response.incomplete" ||
    eventName === "response.failed" ||
    eventName === "error"
  ) {
    state.toolContexts.clear();
    handlers.onChatError?.({
      ...base,
      error: errorMessage(payload, data),
      type: stringField(payload, "type") ?? eventName,
      shellType:
        stringField(payload, "runtime") ?? stringField(data, "runtime"),
    });
  }
}
