import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/tauri/localExecutor'

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
