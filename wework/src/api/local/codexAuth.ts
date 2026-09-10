import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/desktop/localExecutor'

interface CodexChatgptLoginResponse {
  type: 'chatgpt'
  loginId: string
  authUrl: string
}

interface CodexAccountResponse {
  account: unknown | null
}

type LocalExecutorRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export async function startLocalCodexLogin(
  request: LocalExecutorRequest = requestLocalExecutor
): Promise<CodexChatgptLoginResponse> {
  await ensureLocalExecutorStarted()
  const response = recordValue(await request('runtime.codex.auth.login.start'))
  const loginId = typeof response.loginId === 'string' ? response.loginId.trim() : ''
  const authUrl = typeof response.authUrl === 'string' ? response.authUrl.trim() : ''
  if (response.type !== 'chatgpt' || !loginId || !authUrl) {
    throw new Error('Codex returned an invalid login response')
  }
  return { type: 'chatgpt', loginId, authUrl }
}

export async function hasLocalCodexAccount(
  request: LocalExecutorRequest = requestLocalExecutor
): Promise<boolean> {
  const response = (await request('runtime.codex.auth.read')) as CodexAccountResponse
  return response?.account != null
}

export async function cancelLocalCodexLogin(
  loginId: string,
  request: LocalExecutorRequest = requestLocalExecutor
): Promise<void> {
  const normalizedLoginId = loginId.trim()
  if (!normalizedLoginId) return
  await request('runtime.codex.auth.login.cancel', { loginId: normalizedLoginId })
}
