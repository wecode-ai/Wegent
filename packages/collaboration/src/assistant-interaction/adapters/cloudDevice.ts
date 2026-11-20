import { createAssistantEndpoint } from "../endpoint";
import type { AssistantEndpointInput } from "../endpoint";

export function cloudDeviceEndpoint(
  input: Omit<AssistantEndpointInput, "kind">,
) {
  return createAssistantEndpoint({ ...input, kind: "cloud_device" });
}
