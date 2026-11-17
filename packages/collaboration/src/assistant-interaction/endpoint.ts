import type { AssistantEndpoint, AssistantEndpointKind } from "./types";

export interface AssistantEndpointInput {
  kind: AssistantEndpointKind;
  endpointRef?: string;
  ownerUserId: number;
  roleId: string;
  displayName: string;
  availability?: AssistantEndpoint["availability"];
  capabilities?: Partial<AssistantEndpoint["capabilities"]>;
}

export interface ProjectAssistantEndpointRecord {
  endpointRef: string;
  userId: number;
  roleId: string;
  endpointKind: AssistantEndpointKind;
  displayName: string;
  availability: AssistantEndpoint["availability"];
  capabilityTags?: readonly string[];
}

/** Device placement is mutable; member plus role is the endpoint identity. */
export function createAssistantEndpoint(
  input: AssistantEndpointInput,
): AssistantEndpoint {
  if (!Number.isInteger(input.ownerUserId) || input.ownerUserId < 0)
    throw new TypeError("Assistant endpoint owner must be a non-negative user");
  const roleId = input.roleId.trim();
  if (!roleId) throw new TypeError("Assistant endpoint role is required");
  const endpointRef = input.endpointRef?.trim();
  if (endpointRef && !endpointRef.startsWith(`${input.kind}:`))
    throw new TypeError("Assistant endpoint reference does not match its kind");
  if (input.kind === "wegent_agent" && !endpointRef)
    throw new TypeError(
      "Wegent assistant endpoints require the exact agent reference",
    );
  return {
    id: endpointRef || `${input.kind}:${input.ownerUserId}:${roleId}`,
    kind: input.kind,
    ownerUserId: input.ownerUserId,
    displayName: input.displayName.trim() || roleId,
    availability: input.availability ?? "unknown",
    capabilities: {
      attachments: input.capabilities?.attachments ?? false,
      cancel: input.capabilities?.cancel ?? false,
      trace: input.capabilities?.trace ?? false,
      models: [...(input.capabilities?.models ?? [])],
      skills: [...(input.capabilities?.skills ?? [])],
    },
  };
}

export function assistantEndpointFromRoster(
  record: ProjectAssistantEndpointRecord,
): AssistantEndpoint {
  return createAssistantEndpoint({
    kind: record.endpointKind,
    endpointRef: record.endpointRef,
    ownerUserId: record.userId,
    roleId: record.roleId,
    displayName: record.displayName,
    availability: record.availability,
    capabilities: { skills: record.capabilityTags ?? [] },
  });
}
