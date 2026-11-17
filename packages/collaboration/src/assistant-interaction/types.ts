import type { RuntimeTaskAddress } from "@wegent/chat-core/runtime";
import type { RuntimeSendRequest } from "@wegent/chat-core/runtime-task-api-types";

export type AssistantEndpointKind =
  | "local_wework"
  | "cloud_device"
  | "wegent_agent";
export type AssistantInteractionState =
  | "request"
  | "accepted"
  | "needs_input"
  | "draft"
  | "result"
  | "evidence"
  | "failed"
  | "cancelled"
  | "trace";

export interface AssistantEndpoint {
  id: string;
  kind: AssistantEndpointKind;
  ownerUserId: number;
  displayName: string;
  availability: "online" | "offline" | "unknown";
  capabilities: {
    attachments: boolean;
    cancel: boolean;
    trace: boolean;
    models: readonly string[];
    skills: readonly string[];
  };
}

export interface AssistantConversation {
  /** Persisted conversation identity; a device address is only its current route. */
  id: string;
  projectId: string;
  issueId: string;
  ownerUserId: number;
  endpointId: string;
  address: RuntimeTaskAddress;
}

export interface AssistantInteractionRequest {
  requestId: string;
  idempotencyKey: string;
  projectId: string;
  issueId: string;
  senderUserId: number;
  visibility: "private";
  message: string;
  attachmentIds?: number[];
  interruptWhenBusy?: boolean;
  runtimeOptions?: Omit<
    RuntimeSendRequest,
    | "address"
    | "message"
    | "clientUserMessageId"
    | "conversationContext"
    | "queueIfBusy"
    | "attachmentIds"
  >;
}

export interface AssistantInteractionEvent {
  conversationId: string;
  requestId: string;
  sequence: number;
  state: AssistantInteractionState;
  summary?: string;
  error?: string;
  traceRef?: string | null;
}
