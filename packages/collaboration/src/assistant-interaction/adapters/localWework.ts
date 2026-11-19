import { createAssistantEndpoint } from "../endpoint";
import type { AssistantEndpointInput } from "../endpoint";

export function localWeworkEndpoint(
  input: Omit<AssistantEndpointInput, "kind">,
) {
  return createAssistantEndpoint({ ...input, kind: "local_wework" });
}
