import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/desktop/localExecutor'

interface CodexChatgptLoginResponse {
  type: 'chatgpt'
  loginId: string
  authUrl: string
}

export interface LocalCodexAccount {
  id: string
  accountType: string
  email: string | null
  planType: string | null
  createdAt: number
  lastUsedAt: number
}

export interface LocalCodexAccounts {
  activeAccountId: string | null
  accounts: LocalCodexAccount[]
}

type LocalExecutorRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function parseLocalCodexAccounts(value: unknown): LocalCodexAccounts {
  const response = recordValue(value)
  const accounts = Array.isArray(response.accounts)
    ? response.accounts.flatMap(value => {
        const account = recordValue(value)
        const id = typeof account.id === 'string' ? account.id.trim() : ''
        if (!id) return []
        return [
          {
            id,
            accountType: typeof account.accountType === 'string' ? account.accountType : 'unknown',
            email: typeof account.email === 'string' ? account.email : null,
            planType: typeof account.planType === 'string' ? account.planType : null,
            createdAt: typeof account.createdAt === 'number' ? account.createdAt : 0,
            lastUsedAt: typeof account.lastUsedAt === 'number' ? account.lastUsedAt : 0,
          },
        ]
      })
    : []
  return {
    activeAccountId: typeof response.activeAccountId === 'string' ? response.activeAccountId : null,
    accounts,
  }
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

export async function listLocalCodexAccounts(
  request: LocalExecutorRequest = requestLocalExecutor
): Promise<LocalCodexAccounts> {
  return parseLocalCodexAccounts(await request('runtime.codex.accounts.list'))
}

export async function switchLocalCodexAccount(
  accountId: string,
  request: LocalExecutorRequest = requestLocalExecutor
): Promise<LocalCodexAccounts> {
  const normalizedAccountId = accountId.trim()
  if (!normalizedAccountId) throw new Error('Codex account ID is required')
  await ensureLocalExecutorStarted()
  return parseLocalCodexAccounts(
    await request('runtime.codex.accounts.switch', { accountId: normalizedAccountId })
  )
}

export async function cancelLocalCodexLogin(
  loginId: string,
  request: LocalExecutorRequest = requestLocalExecutor
): Promise<void> {
  const normalizedLoginId = loginId.trim()
  if (!normalizedLoginId) return
  await request('runtime.codex.auth.login.cancel', { loginId: normalizedLoginId })
}
