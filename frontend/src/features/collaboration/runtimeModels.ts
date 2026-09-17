import type { CloudRuntimeIpcClient } from '@wegent/chat-core'
import { normalizeCodexOfficialModelList } from '@wegent/chat-core/codex-official-models'
import { deviceApis } from '@/apis/devices'
import { codexRuntimeModels } from '@wegent/chat-core/runtime-model-catalog'
import { createModelApi } from '@wegent/chat-core/model-api'
import { apiClient } from '@/apis/client'

export async function listRuntimeModels(ipc: CloudRuntimeIpcClient, deviceId: string) {
  const [cloud, result, auth] = await Promise.all([
    createModelApi(apiClient).listModels(),
    ipc.request<unknown>('runtime.codex.models.list', { includeHidden: true }, deviceId),
    deviceApis.executeCommand<unknown>(deviceId, {
      command_key: 'runtime_auth_status',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    }),
  ])
  if (!auth.success)
    throw new Error(auth.error || auth.stderr || 'Unable to load runtime authentication status')
  const configured = Boolean(
    auth.stdout &&
    typeof auth.stdout === 'object' &&
    'exists' in auth.stdout &&
    auth.stdout.exists === true
  )
  const catalog = normalizeCodexOfficialModelList(result)
  const errors = catalog.providers.filter(provider => !provider.available || provider.error)
  if (errors.length)
    throw new Error(
      errors.map(provider => provider.error || `${provider.displayName} unavailable`).join('\n')
    )
  return [...codexRuntimeModels(catalog.models, null, configured), ...cloud.data]
}
