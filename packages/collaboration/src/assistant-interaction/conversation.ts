import type { RuntimeTaskAddress } from "@wegent/chat-core/runtime";
import type { AssistantConversation, AssistantEndpoint } from "./types";

export function createAssistantConversation(
  endpoint: AssistantEndpoint,
  input: RuntimeTaskAddress & {
    id: string;
    projectId: string;
    issueId: string;
  },
): AssistantConversation {
  if (
    !input.id.trim() ||
    !input.projectId.trim() ||
    !input.issueId.trim() ||
    !input.deviceId.trim() ||
    !input.taskId.trim()
  )
    throw new TypeError("Assistant conversation scope is required");
  const { id, projectId, issueId, ...address } = input;
  return {
    id,
    projectId,
    issueId,
    ownerUserId: endpoint.ownerUserId,
    endpointId: endpoint.id,
    address,
  };
}
