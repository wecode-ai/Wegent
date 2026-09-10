import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import type { CloudProject } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
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
      listCloudProjectMembers: vi.fn().mockResolvedValue([]),
      listLoopItems: vi.fn().mockResolvedValue({ items: [] }),
      searchCloudProjectUsers: vi.fn().mockResolvedValue({ users: [] }),
      updateCloudProject: vi
        .fn()
        .mockImplementation(
          async (_projectId: string, values: Partial<CloudProject> & { version: number }) => ({
            ...project,
            ...values,
            version: values.version + 1,
          })
        ),
      updateLoopItem: vi.fn(),
      addCloudProjectMember: vi.fn(),
      updateCloudProjectMember: vi.fn(),
      removeCloudProjectMember: vi.fn(),
      ...overrides,
    } as unknown as NonNullable<WorkbenchServices['deliveryApi']>
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
    const updateCloudProject = vi.fn().mockResolvedValue({
      ...project,
      visibility: 'public',
      version: 2,
    })
    const api = createApi({ updateCloudProject })

    render(<CloudProjectManageView api={api} project={project} />)

    await user.click(await screen.findByTestId('cloud-project-members-toggle'))
    await user.click(screen.getByTestId('cloud-project-manage-visibility-public'))

    await waitFor(() =>
      expect(updateCloudProject).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({ version: 1, visibility: 'public' })
      )
    )
  })

  test('keeps tag creation DOM and persistence behavior', async () => {
    const user = userEvent.setup()
    const updateCloudProject = vi.fn().mockResolvedValue({
      ...project,
      tags: ['bug'],
      version: 2,
    })
    const api = createApi({ updateCloudProject })

    render(<CloudProjectManageView api={api} project={project} />)

    await user.click(await screen.findByRole('button', { name: '＋ 新建标签' }))
    await user.type(screen.getByTestId('cloud-project-tag-create-input'), 'bug')
    await user.click(screen.getByTestId('cloud-project-tag-create-confirm'))

    await waitFor(() =>
      expect(updateCloudProject).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({ version: 1, tags: ['bug'] })
      )
    )
    expect(await screen.findByTestId('cloud-project-tag-bug')).toBeInTheDocument()
  })
})
