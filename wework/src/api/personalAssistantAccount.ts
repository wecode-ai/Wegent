import type { HttpClient } from './http'
import type { PersonalStandInSettings } from './personalStandIn'

interface ResourceRef {
  name: string
  namespace: string
}

export interface PersonalAssistantDefinition {
  roleId: string
  bot: { metadata: ResourceRef & { displayName?: string } }
  ghost: { spec: { systemPrompt: string } }
}

export interface PersonalAssistantAccount {
  defaultBotRef: ResourceRef
  revision: string
  retiredRoleIds: string[]
  definitions: PersonalAssistantDefinition[]
}

interface AccountResponse {
  assistant: PersonalAssistantAccount | null
}

export function assistantDefinitionInputs(name: string, settings?: PersonalStandInSettings) {
  return [
    { roleId: '@primary', name, prompt: settings?.primary?.prompt ?? '' },
    ...(settings?.roles ?? []).map(role => ({
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
    async initialize(name: string, settings?: PersonalStandInSettings) {
      const { assistant } = await client.post<AccountResponse>('/v1/personal-assistant', {
        definitions: assistantDefinitionInputs(name, settings),
      })
      if (!assistant) throw new Error('Personal assistant initialization returned no definition')
      return assistant
    },
    async updateDefinitions(
      revision: string,
      definitions: ReturnType<typeof assistantDefinitionInputs>
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
