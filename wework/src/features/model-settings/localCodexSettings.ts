import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/desktop/localExecutor'

export type CodexPersonality = 'friendly' | 'pragmatic'

export const DEFAULT_CODEX_PERSONALITY: CodexPersonality = 'pragmatic'

interface CodexPersonalityResponse {
  personality?: unknown
}

function normalizePersonality(response: CodexPersonalityResponse): CodexPersonality {
  return response.personality === 'friendly' || response.personality === 'pragmatic'
    ? response.personality
    : DEFAULT_CODEX_PERSONALITY
}

export async function getLocalCodexPersonality(): Promise<CodexPersonality> {
  await ensureLocalExecutorStarted()
  const response = await requestLocalExecutor<CodexPersonalityResponse>(
    'runtime.codex.personality.read'
  )
  return normalizePersonality(response)
}

export async function saveLocalCodexPersonality(
  personality: CodexPersonality
): Promise<CodexPersonality> {
  await ensureLocalExecutorStarted()
  const response = await requestLocalExecutor<CodexPersonalityResponse>(
    'runtime.codex.personality.write',
    { personality }
  )
  return normalizePersonality(response)
}

interface CodexTransportConfig {
  version: string
  config: { model_providers?: Record<string, { name?: string; supports_websockets?: boolean }> }
  name: { type: string; profile?: string | null }
}

const WEWORK_CODEX_PROVIDER = '~'

async function readCodexTransportConfig() {
  await ensureLocalExecutorStarted()
  const response = await requestLocalExecutor<{ layers: CodexTransportConfig[] }>(
    'codex.app_server_request',
    {
      method: 'config/read',
      params: { includeLayers: true, cwd: null },
    }
  )
  // The shared app-server's CLI provider masks the persisted preference.
  return response.layers.find(layer => layer.name.type === 'user' && layer.name.profile == null)
}

export async function getLocalCodexTransport() {
  const layer = await readCodexTransportConfig()
  return layer?.config.model_providers?.[WEWORK_CODEX_PROVIDER]?.supports_websockets === true
    ? 'websocket'
    : 'http'
}

export type LocalCodexTransport = 'http' | 'websocket'

export async function saveLocalCodexTransport(transport: LocalCodexTransport) {
  const layer = await readCodexTransportConfig()
  const provider = layer?.config.model_providers?.[WEWORK_CODEX_PROVIDER]
  await requestLocalExecutor('codex.app_server_request', {
    method: 'config/value/write',
    params: {
      keyPath: `model_providers."${WEWORK_CODEX_PROVIDER}"`,
      value: {
        ...(provider?.name === undefined ? { name: 'Wework' } : {}),
        supports_websockets: transport === 'websocket',
      },
      mergeStrategy: 'upsert',
      expectedVersion: layer?.version ?? null,
    },
  })
}
