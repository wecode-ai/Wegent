import type {
  RuntimeTaskAddress,
  RuntimeTranscriptResponse,
} from "@wegent/chat-core/runtime";
import type {
  AssistantConversation,
  AssistantEndpoint,
  AssistantInteractionEvent,
  AssistantInteractionRequest,
} from "./types";
import { projectAssistantInteractionEvents } from "./events";

export interface AssistantInteractionTransport {
  sendRuntimeMessage(input: {
    address: RuntimeTaskAddress;
    message: string;
    clientUserMessageId: string;
    attachmentIds?: number[];
    interruptWhenBusy?: boolean;
    runtimeOptions?: AssistantInteractionRequest["runtimeOptions"];
    conversationContext: "private_discussion";
    queueIfBusy: boolean;
  }): Promise<{
    accepted: boolean;
    taskId: string;
    status?: "queued" | "running";
    queuePosition?: number | null;
    turnId?: string;
    error?: string | null;
  }>;
  cancelRuntimeTask(
    address: RuntimeTaskAddress,
  ): Promise<{ accepted: boolean; error?: string | null }>;
  getRuntimeTranscript(
    address: RuntimeTaskAddress,
  ): Promise<RuntimeTranscriptResponse>;
}

export class AssistantInteractionError extends Error {
  readonly code:
    | "scope_mismatch"
    | "unsupported_attachments"
    | "unsupported_cancel"
    | "unsupported_trace"
    | "history_unavailable"
    | "request_rejected";

  constructor(
    code:
      | "scope_mismatch"
      | "unsupported_attachments"
      | "unsupported_cancel"
      | "unsupported_trace"
      | "history_unavailable"
      | "request_rejected",
    message: string,
  ) {
    super(message);
    this.name = "AssistantInteractionError";
    this.code = code;
  }
}

/** All endpoint kinds use the existing Runtime transport and retain their original history. */
export function createAssistantInteraction(
  endpoint: AssistantEndpoint,
  conversation: AssistantConversation,
  transport: AssistantInteractionTransport,
) {
  if (
    endpoint.id !== conversation.endpointId ||
    endpoint.ownerUserId !== conversation.ownerUserId
  )
    throw new AssistantInteractionError(
      "scope_mismatch",
      "Endpoint does not own this conversation",
    );

  let lastRequest: AssistantInteractionRequest | null = null;

  async function historyResult() {
    const result = await transport.getRuntimeTranscript(conversation.address);
    if (
      result.historyUnavailable ||
      (result.taskId && result.taskId !== conversation.address.taskId)
    )
      throw new AssistantInteractionError(
        "history_unavailable",
        "Original conversation history is unavailable",
      );
    return result;
  }

  async function send(request: AssistantInteractionRequest) {
    if (
      request.projectId !== conversation.projectId ||
      request.issueId !== conversation.issueId ||
      request.senderUserId !== conversation.ownerUserId ||
      request.visibility !== "private" ||
      !request.requestId.trim() ||
      !request.idempotencyKey.trim() ||
      !request.message.trim()
    )
      throw new AssistantInteractionError(
        "scope_mismatch",
        "Request does not match this conversation",
      );
    if (
      (request.attachmentIds?.length ||
        request.runtimeOptions?.attachments?.length) &&
      !endpoint.capabilities.attachments
    )
      throw new AssistantInteractionError(
        "unsupported_attachments",
        "Endpoint does not support attachments",
      );
    lastRequest = request;
    const result = await transport.sendRuntimeMessage({
      address: conversation.address,
      message: request.message,
      clientUserMessageId: request.idempotencyKey,
      attachmentIds: request.attachmentIds,
      ...(request.interruptWhenBusy ? { interruptWhenBusy: true } : {}),
      ...(request.runtimeOptions
        ? { runtimeOptions: request.runtimeOptions }
        : {}),
      conversationContext: "private_discussion",
      queueIfBusy: !request.interruptWhenBusy,
    });
    if (!result.accepted || result.taskId !== conversation.address.taskId)
      throw new AssistantInteractionError(
        "request_rejected",
        result.error || "Request was not accepted",
      );
    return {
      conversationId: conversation.id,
      requestId: request.requestId,
      state: "accepted" as const,
      ...(result.status === "queued" ? { queued: true } : {}),
    };
  }

  return {
    endpoint,
    conversationId: conversation.id,
    send,
    resume: send,
    async cancel() {
      if (!endpoint.capabilities.cancel)
        throw new AssistantInteractionError(
          "unsupported_cancel",
          "Endpoint does not support cancellation",
        );
      const result = await transport.cancelRuntimeTask(conversation.address);
      if (!result.accepted)
        throw new AssistantInteractionError(
          "request_rejected",
          result.error || "Cancellation was not accepted",
        );
      return { conversationId: conversation.id, state: "cancelled" as const };
    },
    async history() {
      return historyResult();
    },
    async events(
      requestId?: string,
      traceRef?: string | null,
    ): Promise<AssistantInteractionEvent[]> {
      if (!lastRequest || (requestId && requestId !== lastRequest.requestId))
        throw new AssistantInteractionError(
          "request_rejected",
          "No matching assistant request is available",
        );
      if (traceRef && !endpoint.capabilities.trace)
        throw new AssistantInteractionError(
          "unsupported_trace",
          "Endpoint does not support execution traces",
        );
      return projectAssistantInteractionEvents(
        conversation.id,
        lastRequest,
        await historyResult(),
        traceRef,
      );
    },
  };
}
