import type { HttpClient } from './http'
import type { PersonalStandInSettings } from './personalStandIn'

interface ResourceRef {
  name: string
  namespace: string
}

interface AssistantTeamMember {
  botRef: ResourceRef
  role?: string
  requireConfirmation?: boolean
}

export interface PersonalAssistantDefinition {
  roleId: string
  team?: {
    metadata: ResourceRef & { displayName?: string }
    spec: { collaborationModel: string; members: AssistantTeamMember[] }
  }
  bot: {
    spec?: { execution_policy?: { mode: string; environment_id?: string } }
    metadata: ResourceRef & { displayName?: string }
  }
  ghost: { spec: { systemPrompt: string } }
  members?: Array<{
    member: AssistantTeamMember
    bot: PersonalAssistantDefinition['bot']
    ghost: PersonalAssistantDefinition['ghost']
  }>
}

export type PersonalAssistantAccount = {
  revision: string
  retiredRoleIds: string[]
  definitions: PersonalAssistantDefinition[]
  stopIntents?: PersonalAssistantStopIntent[]
  stopIntentGenerations?: Record<string, string>
} & (
  | { defaultTeamRef: ResourceRef; defaultBotRef?: never }
  | { defaultBotRef: ResourceRef; defaultTeamRef?: never }
)

export interface PersonalAssistantStopIntent {
  deviceId: string
  requestId: string
  expectedVersion?: number
}

interface AccountResponse {
  assistant: PersonalAssistantAccount | null
}

function readAssistantAccount(response: AccountResponse): PersonalAssistantAccount | null {
  const account = response?.assistant
  if (account === null) return null
  const reference = account?.defaultTeamRef ?? account?.defaultBotRef
  if (
    !account ||
    !reference?.name ||
    !reference.namespace ||
    typeof account.revision !== 'string' ||
    !Array.isArray(account.retiredRoleIds) ||
    !Array.isArray(account.definitions) ||
    account.definitions.some(
      definition =>
        !definition?.roleId ||
        (Boolean(account.defaultTeamRef) && !definition.team?.metadata?.name) ||
        !definition.bot?.metadata?.name ||
        typeof definition.ghost?.spec?.systemPrompt !== 'string'
    )
  ) {
    throw new Error('Cloud personal assistant response contains an incomplete definition')
  }
  return account
}

export function assistantDefinitionName(definition: PersonalAssistantDefinition) {
  return definition.team?.metadata.displayName ?? definition.bot.metadata.displayName
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
      return readAssistantAccount(
        await client.get<AccountResponse>('/v1/personal-assistant', { signal })
      )
    },
    async initialize(name: string, settings?: PersonalStandInSettings, defaultDevice?: string) {
      const assistant = readAssistantAccount(
        await client.post<AccountResponse>('/v1/personal-assistant', {
          definitions: assistantDefinitionInputs(name, settings, defaultDevice),
        })
      )
      if (!assistant) throw new Error('Personal assistant initialization returned no definition')
      return assistant
    },
    async updateDefinitions(
      revision: string,
      definitions: Array<
        ReturnType<typeof assistantDefinitionInputs>[number] & { executionDeviceId?: string }
      >
    ) {
      const assistant = readAssistantAccount(
        await client.patch<AccountResponse>('/v1/personal-assistant', {
          revision,
          desired: { definitions },
        })
      )
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
