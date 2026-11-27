import type { HttpClient } from './http'
import type { PersonalStandInSettings } from './personalStandIn'

interface ResourceRef {
  name: string
  namespace: string
}

export interface PersonalAssistantDefinition {
  roleId: string
  team: {
    metadata: ResourceRef & { displayName?: string }
    spec: { collaborationModel: 'solo'; members: [{ botRef: ResourceRef; role: 'leader' }] }
  }
  bot: {
    spec?: { execution_policy?: { mode: string; environment_id?: string } }
    metadata: ResourceRef & { displayName?: string }
  }
  ghost: { spec: { systemPrompt: string } }
}

export interface PersonalAssistantAccount {
  defaultTeamRef: ResourceRef
  revision: string
  retiredRoleIds: string[]
  definitions: PersonalAssistantDefinition[]
}

interface AccountResponse {
  assistant: PersonalAssistantAccount | null
}

export function assistantDefinitionInputs(
  name: string,
  settings?: PersonalStandInSettings,
  defaultDevice?: string
) {
  return [
    {
      roleId: '@primary',
      name,
      prompt: settings?.primary?.prompt ?? '',
      executionDeviceId: settings?.executionDeviceId ?? defaultDevice,
    },
    ...(settings?.roles ?? []).map(role => ({
      executionDeviceId: role.executionDeviceId,
      roleId: role.id,
      name: role.name,
      prompt: role.prompt,
    })),
  ]
}

export function createPersonalAssistantAccountApi(client: HttpClient) {
  return {
    async get(signal?: AbortSignal) {
      const { assistant } = await client.get<AccountResponse>('/v1/personal-assistant', { signal })
      return assistant
    },
    async initialize(name: string, settings?: PersonalStandInSettings, defaultDevice?: string) {
      const { assistant } = await client.post<AccountResponse>('/v1/personal-assistant', {
        definitions: assistantDefinitionInputs(name, settings, defaultDevice),
      })
      if (!assistant) throw new Error('Personal assistant initialization returned no definition')
      return assistant
    },
    async updateDefinitions(
      revision: string,
      definitions: Array<
        ReturnType<typeof assistantDefinitionInputs>[number] & { executionDeviceId?: string }
      >
    ) {
      const { assistant } = await client.patch<AccountResponse>('/v1/personal-assistant', {
        revision,
        desired: { definitions },
      })
      if (!assistant) throw new Error('Personal assistant definition was not returned')
      return assistant
    },
  }
}
