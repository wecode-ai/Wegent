import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/tauri/localExecutor'

const READ_CODEX_INSTRUCTIONS_METHOD = 'runtime.codex.instructions.read'
const WRITE_CODEX_INSTRUCTIONS_METHOD = 'runtime.codex.instructions.write'

interface CodexInstructionsResponse {
  instructions?: unknown
  configPath?: unknown
}

export interface CodexInstructions {
  instructions: string
  configPath: string | null
}

function normalizeCodexInstructions(response: CodexInstructionsResponse): CodexInstructions {
  return {
    instructions: typeof response.instructions === 'string' ? response.instructions : '',
    configPath: typeof response.configPath === 'string' ? response.configPath : null,
  }
}

export async function getLocalCodexInstructions(): Promise<CodexInstructions> {
  await ensureLocalExecutorStarted()
  const response = await requestLocalExecutor<CodexInstructionsResponse>(
    READ_CODEX_INSTRUCTIONS_METHOD
  )
  return normalizeCodexInstructions(response)
}

export async function saveLocalCodexInstructions(instructions: string): Promise<CodexInstructions> {
  await ensureLocalExecutorStarted()
  const response = await requestLocalExecutor<CodexInstructionsResponse>(
    WRITE_CODEX_INSTRUCTIONS_METHOD,
    { instructions }
  )
  return normalizeCodexInstructions(response)
}
