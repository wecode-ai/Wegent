import type { AssistantEndpoint, AssistantEndpointKind } from "./types";

export interface AssistantEndpointInput {
  kind: AssistantEndpointKind;
  ownerUserId: number;
  roleId: string;
  displayName: string;
  availability?: AssistantEndpoint["availability"];
  capabilities?: Partial<AssistantEndpoint["capabilities"]>;
}

export interface ProjectAssistantEndpointRecord {
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
  return {
    id: `${input.kind}:${input.ownerUserId}:${roleId}`,
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
    ownerUserId: record.userId,
    roleId: record.roleId,
    displayName: record.displayName,
    availability: record.availability,
    capabilities: { skills: record.capabilityTags ?? [] },
  });
}
