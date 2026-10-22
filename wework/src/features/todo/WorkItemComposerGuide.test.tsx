import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { ProjectSpaceApi } from '@/features/todo/projectSpaceSelection'
import { WorkItemComposerGuide } from './WorkItemComposerGuide'

const project = {
  id: 'work-items',
  public_id: 'project-work-items',
  project_key: 'WORK',
  name: '我的任务',
  project_store: 'local',
} as CloudProject

const teamProject = {
  ...project,
  id: 'team-work',
  project_key: 'TEAM',
  name: '团队研发',
} as CloudProject

const developmentSpace = { id: 'dev', public_id: 'space-dev', name: '产品研发' }
const operationsSpace = { id: 'ops', public_id: 'space-ops', name: '运营协作' }
const projectOptions = () => within(screen.getByRole('listbox'))
const pickerProjects: CloudProject[] = [
  {
    ...teamProject,
    id: 'report',
    name: '行业周报',
    project_store: 'backend',
    project_key: 'REPORT',
    workspace_context: developmentSpace,
  },
  {
    ...teamProject,
    id: 'weekly',
    name: '行业周报',
    project_store: 'backend',
    project_key: 'WEEKLY',
    workspace_context: operationsSpace,
  },
  {
    ...teamProject,
    id: 'ai',
    name: 'AI业务支持',
    project_store: 'backend',
    project_key: 'AIBIZ',
    workspace_context: developmentSpace,
  },
  { ...teamProject, id: 'local', name: 'Wegent', project_key: 'WEGENT' },
]

const item = {
  id: 'WORK-1',
  title: '完成默认工作项流程',
  status: 'in_review',
  assignee_name: '张三',
  assignee_agent_name: null,
  ai_state: null,
} as CloudLoopItem

const taskBindings = [
  {
    id: 1,
    loop_item_id: 'WORK-1',
    task_user_id: 7,
    device_id: 'local-device',
    task_id: 'runtime-1',
    task_title: '当前执行任务',
    backend_task_id: null,
    linked_at: '2026-08-16T00:00:00Z',
  },
  {
    id: 2,
    loop_item_id: 'WORK-1',
    task_user_id: 7,
    device_id: 'local-device',
    task_id: 'runtime-2',
    task_title: '补充验证任务',
    backend_task_id: null,
    linked_at: '2026-08-16T00:01:00Z',
  },
]

describe('WorkItemComposerGuide', () => {
  test('shows project context without an empty menu when no project choices are available', async () => {
    const user = userEvent.setup()
    render(<WorkItemComposerGuide integrated toolbar project={project} />)

    const context = screen.getByTestId('project-space-context-pill')
    expect(context).toHaveTextContent('我的任务')
    expect(context).not.toHaveAttribute('aria-haspopup')
    expect(context).not.toHaveAttribute('aria-expanded')
    expect(context.tagName).toBe('DIV')

    await user.click(context)

    expect(screen.queryByTestId('work-item-context-menu')).not.toBeInTheDocument()
  })

  test('shows the default workspace as the selected destination for a new task', async () => {
    const user = userEvent.setup()
    const onSelectProject = vi.fn()
    render(
      <WorkItemComposerGuide
        project={project}
        projects={[teamProject]}
        toolbar
        onSelectProject={onSelectProject}
      />
    )

    const trigger = screen.getByTestId('project-space-context-pill')
    expect(trigger).toHaveTextContent('我的任务')
    expect(trigger).toHaveClass(
      'h-8',
      'gap-1.5',
      'rounded-lg',
      'px-2',
      'text-sm',
      'font-normal',
      'text-text-secondary'
    )
    expect(trigger).not.toHaveClass('text-primary', 'font-medium')

    await user.click(trigger)
    const menu = screen.getByTestId('work-item-context-menu')
    expect(menu).not.toHaveTextContent('我的任务')
    expect(screen.getByTestId('work-item-workspace-option-team-work')).toHaveTextContent('团队研发')

    await user.click(screen.getByTestId('work-item-workspace-option-team-work'))
    expect(onSelectProject).toHaveBeenCalledWith(teamProject)
  })

  test('reopens Issue selection for the current draft project', async () => {
    const user = userEvent.setup()
    const onSelectProject = vi.fn()
    render(
      <WorkItemComposerGuide
        project={teamProject}
        projects={[teamProject]}
        toolbar
        onSelectProject={onSelectProject}
      />
    )

    await user.click(screen.getByTestId('project-space-context-pill'))
    const selected = screen.getByTestId('work-item-workspace-option-team-work')
    expect(selected).toHaveAttribute('aria-selected', 'true')
    await user.click(selected)
    expect(onSelectProject).toHaveBeenCalledExactlyOnceWith(teamProject)
  })

  test('uses the goal as primary context and only shows sibling tasks', async () => {
    const api = {
      listTaskBindings: vi.fn().mockResolvedValue(taskBindings),
      findCloudContextForTask: vi.fn().mockResolvedValue({
        project,
        loop_item: item,
      }),
    } as unknown as ProjectSpaceApi

    render(
      <WorkItemComposerGuide
        item={item}
        api={api}
        currentTask={{ deviceId: 'local-device', taskId: 'runtime-1' }}
        goalPresent
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId('work-item-guide-summary-details')).toHaveTextContent(
        '2 个任务，还有 1 个'
      )
    )
    expect(screen.getByTestId('project-space-context-pill')).toHaveTextContent('工作空间')
    expect(screen.queryByText('等待确认')).not.toBeInTheDocument()
    expect(screen.queryByTestId('work-item-guide-summary-title')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-space-context-pill')).not.toHaveTextContent('我的任务')
    expect(screen.getByTestId('project-space-context-pill')).not.toHaveTextContent('WORK-1')
    expect(screen.getByTestId('project-space-context-pill')).not.toHaveTextContent('下一步')
  })

  test('shows the work-item title when there is no active goal', async () => {
    const api = {
      listTaskBindings: vi.fn().mockResolvedValue(taskBindings),
      findCloudContextForTask: vi.fn().mockResolvedValue(null),
    } as unknown as ProjectSpaceApi

    render(
      <WorkItemComposerGuide
        item={item}
        api={api}
        currentTask={{ deviceId: 'local-device', taskId: 'runtime-1' }}
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId('work-item-guide-summary-title')).toHaveTextContent(
        '完成默认工作项流程'
      )
    )
    expect(screen.queryByText('等待确认')).not.toBeInTheDocument()
  })

  test('refreshes the linked work item when runtime execution settles', async () => {
    const runningItem = {
      ...item,
      title: '执行中的任务',
      status: 'in_progress' as const,
    }
    const settledItem = {
      ...item,
      title: '已同步的任务',
    }
    const api = {
      listTaskBindings: vi.fn().mockResolvedValue(taskBindings),
      findCloudContextForTask: vi
        .fn()
        .mockResolvedValueOnce({ project, loop_item: runningItem })
        .mockResolvedValueOnce({ project, loop_item: settledItem }),
    } as unknown as ProjectSpaceApi
    const props = {
      item: runningItem,
      api,
      currentTask: { deviceId: 'local-device', taskId: 'runtime-1' },
    }
    const { rerender } = render(<WorkItemComposerGuide {...props} refreshKey="running" />)

    await waitFor(() =>
      expect(screen.getByTestId('work-item-guide-summary-title')).toHaveTextContent('执行中的任务')
    )

    rerender(<WorkItemComposerGuide {...props} refreshKey="done" />)

    await waitFor(() =>
      expect(screen.getByTestId('work-item-guide-summary-title')).toHaveTextContent('已同步的任务')
    )
    expect(api.findCloudContextForTask).toHaveBeenCalledTimes(2)
  })

  test('summarizes sibling tasks without opening a second menu', async () => {
    const api = {
      listTaskBindings: vi.fn().mockResolvedValue(taskBindings),
      findCloudContextForTask: vi.fn().mockResolvedValue(null),
    } as unknown as ProjectSpaceApi

    render(
      <WorkItemComposerGuide
        item={item}
        api={api}
        currentTask={{ deviceId: 'local-device', taskId: 'runtime-1' }}
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId('work-item-guide-summary-details')).toHaveTextContent(
        '2 个任务，还有 1 个'
      )
    )
    expect(screen.queryByTestId('work-item-context-menu')).not.toBeInTheDocument()
    expect(screen.queryByTestId('work-item-task-1')).not.toBeInTheDocument()
  })

  test('exposes direct actions for details and the full workspace', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    const onOpenBoard = vi.fn()
    render(<WorkItemComposerGuide item={item} onOpen={onOpen} onOpenBoard={onOpenBoard} />)

    const detailsButton = screen.getByTestId('work-item-open-details')
    const workspaceButton = screen.getByTestId('work-item-open-board-menu')
    expect(detailsButton).toHaveAccessibleName('查看 Issue 详情')
    expect(workspaceButton).toHaveAccessibleName('在工作空间中打开')
    expect(detailsButton).toHaveTextContent('')
    expect(workspaceButton).toHaveTextContent('')

    await user.click(detailsButton)
    expect(onOpen).toHaveBeenCalledOnce()

    await user.click(workspaceButton)
    expect(onOpenBoard).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('work-item-context-menu')).not.toBeInTheDocument()
  })

  test('allows an already linked task to choose another board', async () => {
    const user = userEvent.setup()
    const onSelectProject = vi.fn()
    render(
      <WorkItemComposerGuide
        project={project}
        item={item}
        projects={[project, teamProject]}
        onSelectProject={onSelectProject}
      />
    )

    await user.click(screen.getByTestId('work-item-change-board'))
    await user.click(screen.getByTestId('work-item-workspace-option-team-work'))

    expect(onSelectProject).toHaveBeenCalledWith(teamProject)
  })

  test('filters by space and search together and recovers from an empty result', async () => {
    const user = userEvent.setup()
    const onRemoveProject = vi.fn()
    render(
      <WorkItemComposerGuide
        project={pickerProjects[2]}
        projects={pickerProjects}
        onSelectProject={vi.fn()}
        onRemoveProject={onRemoveProject}
      />
    )

    await user.click(screen.getByTestId('project-space-context-pill'))
    const menu = screen.getByRole('dialog', { name: '加入项目空间' })
    const search = screen.getByTestId('project-space-picker-search')
    await waitFor(() => expect(search).toHaveFocus())
    expect(projectOptions().getAllByRole('option')).toHaveLength(4)
    await user.click(within(menu).getByRole('button', { name: '运营协作' }))
    expect(projectOptions().getAllByRole('option')).toHaveLength(1)
    expect(projectOptions().getByRole('option')).toHaveAccessibleName(
      '行业周报 · 运营协作 · WEEKLY'
    )

    await user.type(search, '不存在')
    expect(projectOptions().queryAllByRole('option')).toHaveLength(0)
    expect(fireEvent.keyDown(search, { key: 'Enter' })).toBe(false)
    expect(screen.getByTestId('project-space-picker-empty')).toHaveTextContent('没有匹配的项目')
    expect(screen.getByTestId('clear-project-space-context-button')).toBeVisible()
    await user.click(screen.getByTestId('project-space-picker-clear-search'))
    expect(search).toHaveFocus()
    expect(projectOptions().getAllByRole('option')).toHaveLength(1)
    await user.click(within(menu).getByRole('button', { name: '全部空间' }))
    await user.type(search, '研发 report')
    expect(projectOptions().getByRole('option')).toHaveAccessibleName(
      '行业周报 · 产品研发 · REPORT'
    )
    await user.click(screen.getByTestId('clear-project-space-context-button'))
    expect(onRemoveProject).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('work-item-context-menu')).not.toBeInTheDocument()
  })

  test('sorts in both directions and distinguishes projects with duplicate names', async () => {
    const user = userEvent.setup()
    const onSelectProject = vi.fn()
    render(
      <WorkItemComposerGuide
        project={project}
        projects={pickerProjects}
        onSelectProject={onSelectProject}
      />
    )

    await user.click(screen.getByTestId('project-space-context-pill'))
    const ascending = projectOptions()
      .getAllByRole('option')
      .map(option => option.getAttribute('data-project-space-key'))
    await user.selectOptions(screen.getByTestId('project-space-picker-sort'), 'name-desc')
    const descending = projectOptions()
      .getAllByRole('option')
      .map(option => option.getAttribute('data-project-space-key'))
    const englishKeys = new Set(['backend:ai', 'local:local'])
    expect(ascending.filter(key => englishKeys.has(key!))).toEqual(['backend:ai', 'local:local'])
    expect(descending.filter(key => englishKeys.has(key!))).toEqual(['local:local', 'backend:ai'])
    expect(ascending.filter(key => !englishKeys.has(key!))).toEqual([
      'backend:report',
      'backend:weekly',
    ])
    expect(descending.filter(key => !englishKeys.has(key!))).toEqual([
      'backend:report',
      'backend:weekly',
    ])
    await user.click(projectOptions().getByRole('option', { name: '行业周报 · 运营协作 · WEEKLY' }))
    expect(onSelectProject).toHaveBeenCalledWith(pickerProjects[1])
  })

  test('uses storage as part of project identity when IDs and names collide', async () => {
    const user = userEvent.setup()
    const local = { ...teamProject, id: 'shared', name: '周报', project_key: 'LOCAL' }
    const cloud = { ...local, project_store: 'backend' as const, project_key: 'CLOUD' }
    const onSelectProject = vi.fn()
    render(
      <WorkItemComposerGuide
        project={cloud}
        projects={[local, cloud]}
        onSelectProject={onSelectProject}
      />
    )

    await user.click(screen.getByTestId('project-space-context-pill'))
    const localOption = projectOptions().getByRole('option', { name: '周报 · 本地项目 · LOCAL' })
    const cloudOption = projectOptions().getByRole('option', { name: '周报 · 云端项目 · CLOUD' })
    expect(localOption).toHaveAttribute('aria-selected', 'false')
    expect(cloudOption).toHaveAttribute('aria-selected', 'true')
    await user.click(localOption)
    expect(onSelectProject).toHaveBeenCalledWith(local)
  })

  test('moves the keyboard target when the current project changes storage with the same ID', async () => {
    const user = userEvent.setup()
    const local = { ...teamProject, id: 'shared', name: '周报', project_key: 'LOCAL' }
    const cloud = { ...local, project_store: 'backend' as const, project_key: 'CLOUD' }
    const onSelectProject = vi.fn()
    const props = { projects: [local, cloud], onSelectProject }
    const { rerender } = render(<WorkItemComposerGuide {...props} project={local} />)
    await user.click(screen.getByTestId('project-space-context-pill'))

    rerender(<WorkItemComposerGuide {...props} project={cloud} />)

    const search = screen.getByTestId('project-space-picker-search')
    await waitFor(() => expect(search).toHaveFocus())
    const option = projectOptions().getByRole('option', { name: '周报 · 云端项目 · CLOUD' })
    expect(search).toHaveAttribute('aria-activedescendant', option.id)
    await user.keyboard('{Enter}')
    expect(onSelectProject).toHaveBeenCalledExactlyOnceWith(cloud)
  })

  test('preserves search and keyboard navigation when the same project is refreshed', async () => {
    const user = userEvent.setup()
    const onSelectProject = vi.fn()
    const props = { projects: pickerProjects, onSelectProject }
    const { rerender } = render(<WorkItemComposerGuide {...props} project={pickerProjects[2]} />)
    await user.click(screen.getByTestId('project-space-context-pill'))
    await user.type(screen.getByTestId('project-space-picker-search'), '周报')
    await user.keyboard('{ArrowDown}')

    rerender(<WorkItemComposerGuide {...props} project={{ ...pickerProjects[2] }} />)

    expect(screen.getByTestId('project-space-picker-search')).toHaveValue('周报')
    await user.keyboard('{Enter}')
    expect(onSelectProject).toHaveBeenCalledExactlyOnceWith(pickerProjects[1])
  })

  test('supports keyboard selection, ignores IME confirmation and restores focus on Escape', async () => {
    const user = userEvent.setup()
    const onSelectProject = vi.fn()
    render(
      <WorkItemComposerGuide
        project={project}
        projects={pickerProjects}
        onSelectProject={onSelectProject}
      />
    )
    const trigger = screen.getByTestId('project-space-context-pill')
    await user.click(trigger)
    const search = screen.getByTestId('project-space-picker-search')
    await user.type(search, '周报')
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true })
    expect(onSelectProject).not.toHaveBeenCalled()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onSelectProject).toHaveBeenCalledWith(pickerProjects[1])
    expect(trigger).toHaveFocus()

    await user.click(trigger)
    expect(screen.getByTestId('project-space-picker-search')).toHaveValue('')
    await waitFor(() => expect(screen.getByTestId('project-space-picker-search')).toHaveFocus())
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('work-item-context-menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  test('dismisses outside clicks and reselects the project for a bound Issue', async () => {
    const user = userEvent.setup()
    const onSelectProject = vi.fn()
    const { rerender } = render(
      <WorkItemComposerGuide
        project={teamProject}
        projects={[teamProject]}
        onSelectProject={onSelectProject}
      />
    )
    await user.click(screen.getByTestId('project-space-context-pill'))
    await user.click(document.body)
    expect(screen.queryByTestId('work-item-context-menu')).not.toBeInTheDocument()
    expect(onSelectProject).not.toHaveBeenCalled()

    rerender(
      <WorkItemComposerGuide
        project={teamProject}
        item={item}
        projects={[teamProject]}
        onSelectProject={onSelectProject}
      />
    )
    await user.click(screen.getByTestId('work-item-change-board'))
    await user.click(projectOptions().getByRole('option'))
    expect(onSelectProject).toHaveBeenCalledExactlyOnceWith(teamProject)
  })
})
