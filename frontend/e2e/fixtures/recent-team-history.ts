import { randomUUID } from 'node:crypto'
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'
import { ADMIN_USER } from '../config/test-users'
import { ApiClient, createApiClient, type ApiResponse } from '../utils/api-client'
import { buildStorageState, getJwtExpiryMs } from '../utils/auth-state'

export const HISTORY_MODES = ['chat', 'code', 'knowledge', 'task', 'video', 'image'] as const
export type HistoryMode = (typeof HISTORY_MODES)[number]
export interface HistoryTeam {
  id: number
  name: string
}
export interface HistoryTask {
  id: number
  title: string
  prompt: string
  team_id: number | null
}

export function checked<T>(response: ApiResponse<T>, status = 200): T {
  expect(response.status, JSON.stringify(response.data)).toBe(status)
  expect(response.data).not.toBeNull()
  return response.data!
}

export class HistoryAccount {
  private cleanups: Array<() => Promise<void>> = []
  private removedPaths = new Set<string>()
  private sequence = 0
  private botId = 0
  private readonly workspaceName: string

  constructor(
    readonly api: ApiClient,
    readonly token: string,
    readonly prefix: string
  ) {
    this.workspaceName = `${prefix}-workspace`
  }

  async initialize(): Promise<void> {
    const modelName = `${this.prefix}-model`
    checked(
      await this.api.post('/api/v1/namespaces/default/models', {
        kind: 'Model',
        metadata: { name: modelName, namespace: 'default' },
        spec: {
          modelConfig: {
            env: {
              model: 'openai',
              model_id: 'mock-recent-team-model',
              api_key: 'mock-api-key',
              base_url: `${process.env.MOCK_MODEL_SERVER_URL || 'http://localhost:9999'}/v1`,
            },
          },
        },
      }),
      201
    )
    this.removeLater(`/api/v1/namespaces/default/models/${modelName}`)
    const bot = checked(
      await this.api.post<{ id: number }>('/api/bots', {
        name: `${this.prefix}-bot`,
        shell_name: 'Chat',
        namespace: 'default',
        agent_config: { bind_model: modelName, bind_model_type: 'user' },
        system_prompt: 'Answer the user directly without tools.',
      }),
      201
    )
    this.botId = bot.id
    this.removeLater(`/api/bots/${bot.id}`)
    checked(
      await this.api.post('/api/v1/namespaces/default/workspaces', {
        kind: 'Workspace',
        metadata: { name: this.workspaceName, namespace: 'default' },
        spec: { repository: { gitUrl: '', gitRepo: '', gitDomain: '', branchName: '' } },
      }),
      201
    )
    this.removeLater(`/api/v1/namespaces/default/workspaces/${this.workspaceName}`)
  }

  async team(label: string): Promise<HistoryTeam> {
    const team = checked(
      await this.api.post<HistoryTeam>('/api/teams', {
        name: `${this.prefix}-${label}`,
        namespace: 'default',
        bots: [{ bot_id: this.botId, role: 'worker', bot_prompt: '' }],
        // Every candidate supports every mode, so filtering cannot hide history leaks.
        bind_mode: [...HISTORY_MODES],
        requires_workspace: false,
      }),
      201
    )
    this.removeLater(`/api/v1/namespaces/default/teams/${team.name}`)
    return team
  }

  async seed(team: HistoryTeam, mode: HistoryMode = 'chat'): Promise<HistoryTask> {
    const name = `${this.prefix}-history-${++this.sequence}`
    // Persist history through the real CRD API, including reference validation and execution.
    // The browser/send tests below create their new tasks through the real chat transport.
    checked(
      await this.api.post('/api/v1/namespaces/default/tasks', {
        kind: 'Task',
        metadata: { name, namespace: 'default', labels: { taskType: mode, type: 'online' } },
        spec: {
          title: name,
          prompt: name,
          teamRef: { name: team.name, namespace: 'default' },
          workspaceRef: { name: this.workspaceName, namespace: 'default' },
        },
        status: { state: 'Available', status: 'PENDING', progress: 0 },
      }),
      201
    )
    const tasks = await this.tasks()
    const task = tasks.find(item => item.prompt === name)
    expect(task, `Persisted history ${name}`).toBeDefined()
    expect(task!.team_id).toBe(team.id)
    // Finish execution before seeding another entry so completion cannot reorder history.
    await expect
      .poll(
        async () =>
          checked(
            await this.api.get<{ task_status: string }>(`/api/tasks/${task!.id}/runtime-check`)
          ).task_status,
        { timeout: 30_000 }
      )
      .toBe('COMPLETED')
    return task!
  }

  async tasks(): Promise<HistoryTask[]> {
    const result = checked(
      await this.api.get<{ items: HistoryTask[]; total: number }>('/api/tasks?limit=100')
    )
    expect(result.total).toBeLessThanOrEqual(100)
    return result.items
  }

  async recent(mode: HistoryMode = 'chat'): Promise<HistoryTeam[]> {
    return checked(
      await this.api.get<HistoryTeam[]>(
        `/api/users/recent-teams?include_fallback=false&is_code=${mode === 'code'}&mode=${mode}`
      )
    )
  }

  async defaultTeam(): Promise<HistoryTeam> {
    return checked(await this.api.get<HistoryTeam>('/api/teams/default?mode=chat'))
  }

  async removeTeam(team: HistoryTeam): Promise<void> {
    const path = `/api/v1/namespaces/default/teams/${team.name}`
    checked(await this.api.delete(path))
    this.removedPaths.add(path)
  }

  async authenticate(context: BrowserContext, baseURL: string): Promise<void> {
    await context.clearCookies()
    const state = buildStorageState(baseURL, this.token, getJwtExpiryMs(this.token))
    await context.addCookies(state.cookies)
    // Authentication cookies are authoritative; preserve other local state for account-switch tests.
    for (const page of context.pages()) {
      if (new URL(page.url()).origin === new URL(baseURL).origin) {
        await page.evaluate(entries => {
          for (const entry of entries) localStorage.setItem(entry.name, entry.value)
        }, state.origins[0].localStorage)
      }
    }
  }

  private removeLater(path: string): void {
    this.cleanups.push(async () => {
      if (!this.removedPaths.has(path)) checked(await this.api.delete(path))
    })
  }

  async dispose(): Promise<void> {
    const errors: unknown[] = []
    const attempt = async (cleanup: () => Promise<void>) => {
      try {
        await cleanup()
      } catch (error) {
        errors.push(error)
      }
    }
    await attempt(async () => {
      for (const task of await this.tasks()) {
        checked(await this.api.delete(`/api/tasks/${task.id}`))
      }
    })
    for (const cleanup of this.cleanups.reverse()) await attempt(cleanup)
    if (errors.length) throw new AggregateError(errors, 'Recent-team fixture cleanup failed')
  }
}

export const test = base.extend<{
  createHistoryAccount: () => Promise<HistoryAccount>
  history: HistoryAccount
}>({
  createHistoryAccount: async ({ playwright }, use) => {
    // The built-in request fixture depends on storageState, which depends on this account.
    const request = await playwright.request.newContext()
    const admin = createApiClient(request)
    const accounts: Array<{ id: number; account: HistoryAccount }> = []
    try {
      checked(await admin.login(ADMIN_USER.username, ADMIN_USER.password, 1))
      await use(async () => {
        const prefix = `e2e-recent-${randomUUID().slice(0, 8)}`
        const password = `E2e!${randomUUID()}`
        const user = checked(
          await admin.post<{ id: number }>('/api/admin/users', {
            user_name: prefix,
            password,
            role: 'user',
            auth_source: 'password',
          }),
          201
        )
        const api = createApiClient(request)
        const { access_token: token } = checked(await api.login(prefix, password, 1))
        const account = new HistoryAccount(api, token, prefix)
        accounts.push({ id: user.id, account })
        await account.initialize()
        return account
      })
    } finally {
      try {
        const results: unknown[] = []
        for (const { id, account } of accounts.reverse()) {
          try {
            await account.dispose()
          } catch (error) {
            results.push(error)
          }
          try {
            const removed = await admin.delete(`/api/admin/users/${id}`)
            expect(removed.status).toBe(204)
          } catch (error) {
            results.push(error)
          }
        }
        if (results.length) throw new AggregateError(results, 'Account cleanup failed')
      } finally {
        await request.dispose()
      }
    }
  },
  history: async ({ createHistoryAccount }, use) => {
    await use(await createHistoryAccount())
  },
  storageState: async ({ history, baseURL }, use) => {
    await use(buildStorageState(baseURL!, history.token, getJwtExpiryMs(history.token)))
  },
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      localStorage.setItem('user_onboarding_completed', 'true')
    })
    await use(page)
  },
})

export async function expectSelected(page: Page, team: HistoryTeam): Promise<void> {
  await expect(page.getByTestId('message-input')).toHaveAttribute('data-team-id', String(team.id))
}

export function isHistoryRequest(url: string): boolean {
  const parsed = new URL(url)
  return (
    parsed.pathname.endsWith('/users/recent-teams') &&
    parsed.searchParams.get('include_fallback') === 'false'
  )
}
