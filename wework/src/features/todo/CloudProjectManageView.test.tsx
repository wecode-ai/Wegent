import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, test, vi } from 'vitest'
import '@/i18n'
import type { CloudProject, GitLabMrIntegration } from '@/api/deliveries'
import type { createProjectIncomingHookApi } from '@/api/projectIncomingHooks'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { CloudProjectManageView } from './CloudProjectManageView'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>

const telemetryMocks = vi.hoisted(() => ({
  track: vi.fn(),
}))

vi.mock('@/telemetry/client', () => telemetryMocks)

function makeProject(taskProvider: 'local' | 'gitlab' = 'gitlab'): CloudProject {
  return {
    id: '11',
    public_id: 'public-id',
    project_key: 'PRJ',
    name: 'P',
    description: '',
    project_store: 'backend',
    task_provider: taskProvider,
    provider_config:
      taskProvider === 'gitlab' ? { repository: 'group/project', domain: 'gitlab.internal' } : {},
    created_by_user_id: 1,
    status: 'active',
    tags: [],
    version: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

function makeApi(overrides: Partial<DeliveryApi> = {}): DeliveryApi {
  const state = { enabled: false }
  return {
    listCloudProjectMembers: vi.fn(async () => []),
    listLoopItems: vi.fn(async () => ({ items: [] })),
    getGitLabMrIntegration: vi.fn(
      async (): Promise<GitLabMrIntegration> => ({
        enabled: state.enabled,
        repository: 'group/project',
        domain: 'gitlab.internal',
        webhook_url: state.enabled ? 'https://backend/api/v1/webhooks/gitlab/mr/tok' : null,
        hook_installed: state.enabled,
        hook_id: state.enabled ? 123 : 0,
        status: state.enabled ? 'ok' : '',
        last_error: '',
        last_reconcile_at: null,
      })
    ),
    enableGitLabMrIntegration: vi.fn(async (): Promise<GitLabMrIntegration> => {
      state.enabled = true
      return {
        enabled: true,
        repository: 'group/project',
        domain: 'gitlab.internal',
        webhook_url: 'https://backend/api/v1/webhooks/gitlab/mr/tok',
        hook_installed: true,
        hook_id: 123,
        status: 'ok',
        last_error: '',
        last_reconcile_at: null,
      }
    }),
    disableGitLabMrIntegration: vi.fn(async () => {
      state.enabled = false
    }),
    updateCloudProject: vi.fn(async (_id, values) => {
      const payload = values as { ai_automation?: { max_retry_count?: number } }
      return {
        ...makeProject('gitlab'),
        ai_automation: payload.ai_automation ?? {
          auto_retry_on_failure: false,
          max_retry_count: 3,
        },
      } as unknown as CloudProject
    }),
    ...overrides,
  } as unknown as DeliveryApi
}

function renderView(api: DeliveryApi, project: CloudProject) {
  return render(<CloudProjectManageView api={api} project={project} />)
}

describe('CloudProjectManageView GitLab MR integration', () => {
  beforeEach(() => {
    telemetryMocks.track.mockClear()
  })

  it('shows the MR section and loads status for a gitlab project', async () => {
    const api = makeApi()
    renderView(api, makeProject('gitlab'))
    expect(await screen.findByText('GitLab MR 接入')).toBeTruthy()
    await waitFor(() => expect(api.getGitLabMrIntegration).toHaveBeenCalledWith('11'))
    expect(screen.getByTestId('gitlab-mr-integration-toggle').textContent).toBe('接入 MR')
  })

  it('hides the MR section for a local project', () => {
    const api = makeApi()
    renderView(api, makeProject('local'))
    expect(screen.queryByText('GitLab MR 接入')).toBeNull()
    expect(api.getGitLabMrIntegration).not.toHaveBeenCalled()
  })

  it('enables the integration and reveals the webhook URL', async () => {
    const api = makeApi()
    const user = userEvent.setup()
    renderView(api, makeProject('gitlab'))
    const toggle = await screen.findByTestId('gitlab-mr-integration-toggle')
    await user.click(toggle)
    await waitFor(() => expect(api.enableGitLabMrIntegration).toHaveBeenCalledWith('11'))
    await waitFor(() =>
      expect(screen.getByTestId('gitlab-mr-integration-status').textContent).toBe('已接入')
    )
    expect(screen.getByDisplayValue('https://backend/api/v1/webhooks/gitlab/mr/tok')).toBeTruthy()
  })

  it('disables the integration when already enabled', async () => {
    const api = makeApi({
      getGitLabMrIntegration: vi.fn(
        async (): Promise<GitLabMrIntegration> => ({
          enabled: true,
          repository: 'group/project',
          domain: 'gitlab.internal',
          webhook_url: 'https://backend/api/v1/webhooks/gitlab/mr/tok',
          hook_installed: true,
          hook_id: 123,
          status: 'ok',
          last_error: '',
          last_reconcile_at: null,
        })
      ),
    })
    const user = userEvent.setup()
    renderView(api, makeProject('gitlab'))
    const toggle = await screen.findByTestId('gitlab-mr-integration-toggle')
    expect(toggle.textContent).toBe('关闭接入')
    await user.click(toggle)
    await waitFor(() => expect(api.disableGitLabMrIntegration).toHaveBeenCalledWith('11'))
  })

  it('retries the status fetch when the initial load failed', async () => {
    // The initial mount fetch fails (GitLab down); clicking the toggle must
    // retry the fetch instead of being a silent dead-end.
    let calls = 0
    const api = makeApi({
      getGitLabMrIntegration: vi.fn(async (): Promise<GitLabMrIntegration> => {
        calls += 1
        if (calls === 1) throw new Error('gitlab down')
        return {
          enabled: false,
          repository: 'group/project',
          domain: 'gitlab.internal',
          webhook_url: null,
          hook_installed: false,
          hook_id: 0,
          status: '',
          last_error: '',
          last_reconcile_at: null,
        }
      }),
    })
    const user = userEvent.setup()
    renderView(api, makeProject('gitlab'))
    const toggle = await screen.findByTestId('gitlab-mr-integration-toggle')
    expect(calls).toBe(1)
    await user.click(toggle)
    await waitFor(() => expect(calls).toBeGreaterThan(1))
    await waitFor(() => expect(api.enableGitLabMrIntegration).toHaveBeenCalledWith('11'))
  })

  it('saves the AI auto-retry count through project settings', async () => {
    const api = makeApi()
    const user = userEvent.setup()
    renderView(api, makeProject('gitlab'))
    const input = (await screen.findByTestId('gitlab-mr-retry-count')) as HTMLInputElement
    expect(input.value).toBe('10')
    await user.clear(input)
    await user.type(input, '5')
    await user.click(screen.getByTestId('gitlab-mr-retry-save'))
    await waitFor(() =>
      expect(api.updateCloudProject).toHaveBeenCalledWith(
        '11',
        expect.objectContaining({
          ai_automation: { auto_retry_on_failure: false, max_retry_count: 5 },
        })
      )
    )
  })
})

const project: CloudProject = {
  id: 'project-1',
  public_id: 'public-1',
  project_key: 'HOOK',
  name: 'Incoming hook project',
  description: '',
  project_store: 'backend',
  task_provider: 'local',
  provider_config: {},
  card_display: {
    show_assignee: true,
    show_priority: true,
    show_tags: true,
    show_date: true,
  },
  board_config: {
    group_by: 'status',
    statuses: [
      { id: 'inbox', name: '收集箱', color: 'gray' },
      { id: 'pending', name: '待开始', color: 'blue' },
    ],
  },
  ai_automation: {
    auto_retry_on_failure: false,
    max_retry_count: 1,
  },
  created_by_user_id: 1,
  current_user_id: 1,
  current_user_name: 'owner',
  access_role: 'Owner',
  visibility: 'private',
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-08-16T00:00:00Z',
  updated_at: '2026-08-16T00:00:00Z',
}

describe('CloudProjectManageView incoming hooks', () => {
  test('creates and exposes a copyable incoming URL', async () => {
    const hook = {
      id: 'hook-1',
      projectId: project.id,
      name: '外部系统',
      status: 'active' as const,
      webhookUrl: 'https://cloud.example/api/v1/incoming-hooks/secret',
      version: 1,
      createdAt: '2026-08-16T00:00:00Z',
      updatedAt: '2026-08-16T00:00:00Z',
    }
    const incomingHookApi = {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(hook),
      update: vi.fn(),
      rotate: vi.fn(),
    } as unknown as ReturnType<typeof createProjectIncomingHookApi>
    const api = {
      listCloudProjectMembers: vi.fn().mockResolvedValue([]),
      listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as NonNullable<WorkbenchServices['deliveryApi']>
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(<CloudProjectManageView api={api} incomingHookApi={incomingHookApi} project={project} />)

    expect(await screen.findByTestId('incoming-hook-settings')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('incoming-hook-empty-create'))

    await waitFor(() => expect(incomingHookApi.create).toHaveBeenCalledWith(project.id, '外部系统'))
    expect(await screen.findByText(hook.webhookUrl)).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('incoming-hook-copy-hook-1'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(hook.webhookUrl))
  })
})
