import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/tauri/localExecutor'
import {
  normalizeCodexOfficialModelList,
  type CodexOfficialModelList,
} from '@/features/model-settings/codexOfficialModels'

type LocalExecutorRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

export async function requestLocalCodexOfficialModels(
  request: LocalExecutorRequest = requestLocalExecutor
): Promise<CodexOfficialModelList> {
  const response = await request<unknown>('runtime.codex.models.list', {
    includeHidden: false,
  })
  return normalizeCodexOfficialModelList(response)
}

export async function getLocalCodexOfficialModels(): Promise<CodexOfficialModelList> {
  await ensureLocalExecutorStarted()
  return requestLocalCodexOfficialModels()
}
