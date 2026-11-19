import type { RuntimeTranscriptResponse } from "@wegent/chat-core/runtime";
import type {
  AssistantInteractionEvent,
  AssistantInteractionRequest,
} from "./types";

const SUCCEEDED = new Set(["done", "completed", "succeeded"]);
const FAILED = new Set(["failed", "error"]);
const CANCELLED = new Set(["cancelled", "canceled", "interrupted", "aborted"]);
const RUNNING = new Set(["running", "streaming", "in_progress", "inprogress"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function matchesRequest(
  message: RuntimeTranscriptResponse["messages"][number],
  request: AssistantInteractionRequest,
) {
  return [message.clientUserMessageId, message.client_user_message_id].includes(
    request.idempotencyKey,
  );
}

function requestTurn(
  transcript: RuntimeTranscriptResponse,
  request: AssistantInteractionRequest,
) {
  const message = transcript.messages.find((candidate) =>
    matchesRequest(candidate, request),
  );
  const turnId = message?.turnId ?? message?.turn_id;
  return transcript.turns.find((turn) => turn.id === turnId);
}

function assistantText(
  turn: RuntimeTranscriptResponse["turns"][number] | undefined,
) {
  if (!turn) return "";
  return turn.items
    .flatMap((item) =>
      item.type === "assistant_text"
        ? [item.content]
        : item.type === "block" && item.block.type === "text"
          ? [item.block.content ?? ""]
          : [],
    )
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function normalizeStatus(
  turn: RuntimeTranscriptResponse["turns"][number] | undefined,
) {
  return (turn?.runtimeStatus ?? turn?.status ?? "").toLowerCase();
}

function hasPendingInput(
  message: RuntimeTranscriptResponse["messages"][number],
) {
  return (message.blocks ?? []).some((block) => {
    const payload = record(block.renderPayload ?? block.render_payload);
    return (
      payload?.interactionStatus === "pending" ||
      payload?.interaction_status === "pending"
    );
  });
}

function hasEvidence(
  turn: RuntimeTranscriptResponse["turns"][number] | undefined,
  messages: RuntimeTranscriptResponse["messages"],
) {
  return Boolean(
    turn?.fileChanges ||
    turn?.references?.length ||
    turn?.memoryCitations?.length ||
    messages.some(
      (message) =>
        message.fileChanges ||
        message.file_changes ||
        message.references?.length ||
        message.memoryCitations?.length ||
        message.memory_citations?.length ||
        message.blocks?.some((block) => block.type === "tool"),
    ),
  );
}

export function projectAssistantInteractionEvents(
  conversationId: string,
  request: AssistantInteractionRequest,
  transcript: RuntimeTranscriptResponse,
  traceRef?: string | null,
): AssistantInteractionEvent[] {
  const events: AssistantInteractionEvent[] = [];
  const push = (state: AssistantInteractionEvent["state"], values = {}) => {
    events.push({
      conversationId,
      requestId: request.requestId,
      sequence: events.length + 1,
      state,
      ...values,
    });
  };
  push("request", { summary: request.message.trim().slice(0, 2_000) });
  const turn = requestTurn(transcript, request);
  const turnMessages = transcript.messages.filter((message) =>
    turn
      ? (message.turnId ?? message.turn_id) === turn.id
      : matchesRequest(message, request),
  );
  const accepted =
    transcript.acceptedClientUserMessageIds?.includes(request.idempotencyKey) ??
    Boolean(turn);
  if (accepted) push("accepted");
  if (turnMessages.some(hasPendingInput)) push("needs_input");
  const text = assistantText(turn);
  const status = normalizeStatus(turn);
  const error =
    turn?.error ?? turnMessages.find((message) => message.error)?.error;
  if (text && RUNNING.has(status))
    push("draft", { summary: text.slice(0, 2_000) });
  if (text && SUCCEEDED.has(status))
    push("result", { summary: text.slice(0, 2_000) });
  if (hasEvidence(turn, turnMessages)) push("evidence");
  if (FAILED.has(status) || error) push("failed", error ? { error } : {});
  if (CANCELLED.has(status) || turn?.stoppedNotice) push("cancelled");
  if (traceRef) push("trace", { traceRef });
  return events;
}
