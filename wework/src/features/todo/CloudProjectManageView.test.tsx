import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import type { CloudProject } from '@/api/deliveries'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import { CloudProjectManageView } from './CloudProjectManageView'

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

describe('CloudProjectManageView', () => {
  function createApi(overrides: Record<string, unknown> = {}) {
    return {
      projects: {
        update: vi
          .fn()
          .mockImplementation(
            async (_projectId: string, values: { version: number; tags?: string[] }) => ({
              ...project,
              ...values,
              version: values.version + 1,
            })
          ),
      },
      issues: {
        getBoardSnapshot: vi.fn().mockResolvedValue({
          items: [],
          members: [],
          agents: [],
          taskBindings: [],
        }),
        update: vi.fn(),
      },
      members: {
        list: vi.fn().mockResolvedValue([]),
        searchUsers: vi.fn().mockResolvedValue([]),
        add: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
      },
      ...overrides,
    } as unknown as SharedWorkspaceApi
  }

  test('does not render the deprecated event subscription section', async () => {
    const api = createApi()

    render(<CloudProjectManageView api={api} project={project} />)

    expect(await screen.findByRole('heading', { name: '管理项目' })).toBeInTheDocument()
    expect(screen.getByText('管理项目成员、标签和看板布局。')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-board-layout-settings')).toBeInTheDocument()
    expect(screen.queryByTestId('event-subscription-settings')).not.toBeInTheDocument()
    expect(screen.queryByTestId('event-subscription-create')).not.toBeInTheDocument()
  })

  test('keeps visibility state and persistence in the shared manage body', async () => {
    const user = userEvent.setup()
    const updateProject = vi.fn().mockResolvedValue({
      ...project,
      visibility: 'public',
      version: 2,
    })
    const api = createApi({ projects: { update: updateProject } })

    render(<CloudProjectManageView api={api} project={project} />)

    await user.click(await screen.findByTestId('cloud-project-members-toggle'))
    await user.click(screen.getByTestId('cloud-project-manage-visibility-public'))

    await waitFor(() =>
      expect(updateProject).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({ version: 1, visibility: 'public' })
      )
    )
  })

  test('keeps tag creation DOM and persistence behavior', async () => {
    const user = userEvent.setup()
    const updateProject = vi.fn().mockResolvedValue({
      ...project,
      tags: ['bug'],
      version: 2,
    })
    const api = createApi({ projects: { update: updateProject } })

    render(<CloudProjectManageView api={api} project={project} />)

    await user.click(await screen.findByRole('button', { name: '＋ 新建标签' }))
    await user.type(screen.getByTestId('cloud-project-tag-create-input'), 'bug')
    await user.click(screen.getByTestId('cloud-project-tag-create-confirm'))

    await waitFor(() =>
      expect(updateProject).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({ version: 1, tags: ['bug'] })
      )
    )
    expect(await screen.findByTestId('cloud-project-tag-bug')).toBeInTheDocument()
  })

  test('resets project-owned state when navigating to another project', async () => {
    const api = createApi()
    const { rerender } = render(
      <CloudProjectManageView api={api} project={{ ...project, tags: ['old'] }} />
    )

    expect(await screen.findByTestId('cloud-project-tag-old')).toBeInTheDocument()

    rerender(
      <CloudProjectManageView
        api={api}
        project={{
          ...project,
          id: 'project-2',
          project_key: 'NEXT',
          name: 'Next project',
          tags: ['new'],
          visibility: 'public',
        }}
      />
    )

    expect(await screen.findByTestId('cloud-project-tag-new')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-tag-old')).not.toBeInTheDocument()
  })

  test('keeps provider drafts across server refresh and saves with the latest version', async () => {
    const user = userEvent.setup()
    const externalProject: CloudProject = {
      ...project,
      task_provider: 'github',
      provider_config: {
        repository: 'server/original',
        credential_configured: true,
      },
    }
    const updateProject = vi.fn().mockImplementation(
      async (
        _projectId: string,
        values: {
          version: number
          providerConfig?: Record<string, unknown>
        }
      ) => ({
        ...externalProject,
        provider_config: values.providerConfig ?? externalProject.provider_config,
        version: values.version + 1,
      })
    )
    const api = createApi({ projects: { update: updateProject } })
    const { rerender } = render(<CloudProjectManageView api={api} project={externalProject} />)

    const repository = await screen.findByTestId('cloud-project-provider-manage-repository')
    const token = screen.getByTestId('cloud-project-provider-manage-token')
    await user.type(token, 'draft-token')

    rerender(
      <CloudProjectManageView
        api={api}
        project={{
          ...externalProject,
          version: 6,
          provider_config: {
            repository: 'server/refreshed',
            credential_configured: true,
          },
        }}
      />
    )

    expect(repository).toHaveValue('https://github.com/server/refreshed')
    expect(token).toHaveValue('draft-token')

    await user.clear(repository)
    await user.type(repository, 'draft/repository')

    rerender(
      <CloudProjectManageView
        api={api}
        project={{
          ...externalProject,
          version: 7,
          provider_config: {
            repository: 'server/refreshed',
            credential_configured: true,
          },
        }}
      />
    )

    expect(repository).toHaveValue('draft/repository')
    expect(token).toHaveValue('draft-token')

    await user.click(screen.getByTestId('cloud-project-provider-manage-save'))

    await waitFor(() =>
      expect(updateProject).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({
          version: 7,
          providerConfig: {
            repository: 'draft/repository',
            token: 'draft-token',
          },
        })
      )
    )
  })
})
