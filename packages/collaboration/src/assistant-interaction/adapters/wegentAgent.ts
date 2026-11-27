import { createAssistantEndpoint } from "../endpoint";
import type { AssistantEndpointInput } from "../endpoint";

export function wegentAgentEndpoint(
  input: Omit<AssistantEndpointInput, "kind">,
) {
  return createAssistantEndpoint({ ...input, kind: "wegent_agent" });
}
