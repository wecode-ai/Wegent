import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { CloudProject, GitLabMrIntegration } from '@/api/deliveries'
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
})
