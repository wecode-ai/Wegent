import type { HttpClient } from './http'
import type { PersonalStandInSettings } from './personalStandIn'

interface ResourceRef {
  name: string
  namespace: string
}

export interface PersonalAssistantDefinition {
  roleId: string
  bot: {
    spec?: { execution_policy?: { mode: string; environment_id?: string } }
    metadata: ResourceRef & { displayName?: string }
  }
  ghost: { spec: { systemPrompt: string } }
}

export interface PersonalAssistantAccount {
  defaultBotRef: ResourceRef
  revision: string
  retiredRoleIds: string[]
  definitions: PersonalAssistantDefinition[]
  stopIntents?: PersonalAssistantStopIntent[]
  stopIntentGenerations?: Record<string, string>
}

export interface PersonalAssistantStopIntent {
  deviceId: string
  requestId: string
  expectedVersion?: number
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
    async updateStopIntent(
      deviceId: string,
      operation: 'mark' | 'clear',
      requestId: string,
      expectedRequestId?: string | null,
      expectedVersion?: number
    ) {
      const { assistant } = await client.patch<AccountResponse>('/v1/personal-assistant', {
        stopIntent: {
          deviceId,
          operation,
          requestId,
          ...(operation === 'mark'
            ? { expectedRequestId: expectedRequestId ?? null, expectedVersion }
            : {}),
        },
      })
      if (!assistant) throw new Error('Personal assistant stop state was not returned')
      return assistant
    },
  }
}
