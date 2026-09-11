import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { CloudLoopItem, CloudMyWorkItem, CloudProjectMember } from '@/api/deliveries'
import { CloudProjectsHome } from './CloudProjectsHome'
import type { LocatedProjectSpace } from './projectSpaceSelection'

const clipboardMocks = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(),
}))

vi.mock('@/lib/clipboard', () => clipboardMocks)

const project: LocatedProjectSpace = {
  id: 'project-1',
  public_id: 'project-1',
  project_key: 'ALPHA',
  name: 'Alpha project',
  description: 'Alpha description',
  project_store: 'backend',
  task_provider: 'local',
  provider_config: {},
  created_by_user_id: 1,
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-09-01T10:00:00.000Z',
  updated_at: '2026-09-10T10:00:00.000Z',
  location: 'cloud',
}

const item: CloudLoopItem = {
  id: 'item-1',
  cloud_project_id: project.id,
  sequence_number: 1,
  parent_id: null,
  created_by_user_id: 1,
  created_by_user_name: 'Alice',
  assignee_user_id: 1,
  title: 'Review shared workspace',
  description: '',
  status: 'in_review',
  priority: 'none',
  due_at: null,
  tags: [],
  sort_order: 0,
  current_delivery_id: null,
  version: 1,
  created_at: '2026-09-10T09:00:00.000Z',
  updated_at: '2026-09-10T10:00:00.000Z',
  completed_at: null,
}

const myWork: CloudMyWorkItem = {
  ...item,
  project_key: project.project_key,
  project_name: project.name,
  has_active_task: false,
}

const members: CloudProjectMember[] = [
  {
    id: 1,
    user_id: 1,
    user_name: 'Alice',
    email: 'alice@example.com',
    role: 'Owner',
  },
]

function renderHome() {
  const callbacks = {
    onCreateProject: vi.fn(),
    onSelectProject: vi.fn(),
    onManageProject: vi.fn(),
    onSelectItem: vi.fn(),
    onOpenMyWork: vi.fn(),
  }
  render(
    <CloudProjectsHome
      projects={[project]}
      projectCounts={{ 'backend:project-1': 1 }}
      projectMembers={{ 'backend:project-1': members }}
      projectItems={{ 'backend:project-1': [item] }}
      myWork={[myWork]}
      searchQuery=""
      {...callbacks}
    />
  )
  return callbacks
}

describe('CloudProjectsHome shared workspace adapter', () => {
  beforeEach(() => {
    clipboardMocks.copyTextToClipboard.mockReset()
    clipboardMocks.copyTextToClipboard.mockResolvedValue(undefined)
  })

  it('preserves the home actions and existing test ids', async () => {
    const callbacks = renderHome()

    await userEvent.click(screen.getByTestId('cloud-projects-home-create'))
    await userEvent.click(screen.getByTestId('cloud-projects-home-my-work'))
    await userEvent.click(screen.getByTestId('cloud-projects-home-todo-item-1'))

    expect(callbacks.onCreateProject).toHaveBeenCalledOnce()
    expect(callbacks.onOpenMyWork).toHaveBeenCalledOnce()
    expect(callbacks.onSelectItem).toHaveBeenCalledWith(myWork)
    expect(screen.getByText('Alpha project')).toBeInTheDocument()
    expect(screen.getByText('Review shared workspace')).toBeInTheDocument()
  })

  it('opens project rows with pointer and keyboard interactions', async () => {
    const callbacks = renderHome()
    const projectRow = screen.getByText('Alpha project').closest('[role="button"]')

    expect(projectRow).not.toBeNull()
    await userEvent.click(projectRow!)
    fireEvent.keyDown(projectRow!, { key: 'Enter' })

    expect(callbacks.onSelectProject).toHaveBeenCalledTimes(2)
    expect(callbacks.onSelectProject).toHaveBeenLastCalledWith(project)
  })

  it('filters and manages projects in the shared management dialog', async () => {
    const callbacks = renderHome()
    await userEvent.click(screen.getByTestId('cloud-projects-home-manage'))

    const search = screen.getByTestId('cloud-projects-manage-search')
    expect(search).toHaveFocus()
    await userEvent.type(search, 'missing')
    expect(screen.getByText('没有匹配的项目空间')).toBeInTheDocument()

    await userEvent.clear(search)
    const modal = screen.getByText('管理项目空间').closest('section')
    expect(modal).not.toBeNull()
    const manageButtons = within(modal!).getAllByRole('button', { name: '管理' })
    await userEvent.click(manageButtons.at(-1)!)

    expect(callbacks.onManageProject).toHaveBeenCalledWith(project)
    expect(screen.queryByText('管理项目空间')).not.toBeInTheDocument()
  })

  it('uses the Wework clipboard adapter without opening the project', async () => {
    const callbacks = renderHome()
    await userEvent.click(screen.getByTestId('cloud-project-copy-id-project-1'))

    expect(clipboardMocks.copyTextToClipboard).toHaveBeenCalledWith('project-1')
    expect(callbacks.onSelectProject).not.toHaveBeenCalled()
    expect(screen.getByLabelText('项目 ID 已复制')).toBeInTheDocument()
  })
})
