import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import '@/i18n'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
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

describe('WorkItemComposerGuide', () => {
  test('keeps board changes usable while project options refresh', async () => {
    const user = userEvent.setup()
    const onSelectProject = vi.fn()
    const item = { id: 'WORK-1', title: 'Linked work' } as CloudLoopItem
    const props = { project: teamProject, item, onSelectProject }
    const { rerender } = render(<WorkItemComposerGuide {...props} projects={[teamProject]} />)
    const trigger = screen.getByTestId('work-item-change-board')

    rerender(<WorkItemComposerGuide {...props} projects={[]} />)

    expect(screen.getByTestId('work-item-change-board')).toBe(trigger)
    await user.click(trigger)
    expect(screen.getByTestId('work-item-context-menu')).toBeVisible()
    expect(screen.getByTestId('project-space-picker-empty')).toBeVisible()

    rerender(<WorkItemComposerGuide {...props} projects={[teamProject]} />)
    await user.click(screen.getByTestId('work-item-workspace-option-team-work'))
    expect(onSelectProject).toHaveBeenCalledExactlyOnceWith(teamProject)
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

  test.each(['work-item-open-details', 'work-item-open-board-menu'])(
    'dismisses the project picker through %s and allows reopening it',
    async actionTestId => {
      const item = {
        id: 'WORK-1',
        title: '完成默认工作项流程',
        status: 'in_review',
        assignee_name: '张三',
        assignee_agent_name: null,
        ai_state: null,
      } as CloudLoopItem
      const user = userEvent.setup()
      const onOpen = vi.fn()
      const onOpenBoard = vi.fn()
      const onSelectProject = vi.fn()
      render(
        <WorkItemComposerGuide
          project={project}
          item={item}
          projects={[teamProject]}
          onSelectProject={onSelectProject}
          onOpen={onOpen}
          onOpenBoard={onOpenBoard}
        />
      )
      const trigger = screen.getByTestId('work-item-change-board')
      await user.click(trigger)
      expect(screen.getByTestId('work-item-context-menu')).toBeVisible()

      const navigationAction = screen.getByTestId(actionTestId)
      await user.click(navigationAction)

      const navigatesToDetails = actionTestId === 'work-item-open-details'
      expect(onOpen).toHaveBeenCalledTimes(navigatesToDetails ? 1 : 0)
      expect(onOpenBoard).toHaveBeenCalledTimes(navigatesToDetails ? 0 : 1)
      expect(onSelectProject).not.toHaveBeenCalled()
      expect(screen.queryByTestId('work-item-context-menu')).not.toBeInTheDocument()
      expect(trigger).toHaveAttribute('aria-expanded', 'false')
      expect(navigationAction).toHaveFocus()

      await user.click(trigger)
      await user.click(screen.getByTestId('work-item-workspace-option-team-work'))

      expect(onSelectProject).toHaveBeenCalledExactlyOnceWith(teamProject)
      expect(screen.queryByTestId('work-item-context-menu')).not.toBeInTheDocument()
    }
  )

  test('opens the Issue details from the summary title', async () => {
    const item = {
      id: 'WORK-1',
      title: '完成默认工作项流程',
      status: 'in_review',
      assignee_name: '张三',
      assignee_agent_name: null,
      ai_state: null,
    } as CloudLoopItem
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(<WorkItemComposerGuide item={item} onOpen={onOpen} />)

    const summaryButton = screen.getByTestId('work-item-guide-open-summary')
    expect(summaryButton).toHaveClass(
      'hover:bg-background/70',
      'keyboard:focus-visible:ring-2',
      'keyboard:focus-visible:ring-inset',
      'keyboard:focus-visible:ring-primary/30',
      'disabled:hover:bg-transparent'
    )

    await user.click(summaryButton)

    expect(onOpen).toHaveBeenCalledOnce()
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
    const menu = screen.getByRole('dialog', { name: '选择项目' })
    const search = screen.getByTestId('project-space-picker-search')
    await waitFor(() => expect(search).toHaveFocus())
    expect(projectOptions().getAllByRole('option')).toHaveLength(4)
    expect(within(menu).queryByRole('button', { name: '运营协作' })).not.toBeInTheDocument()
    expect(within(menu).getByRole('button', { name: '远程项目' })).toBeVisible()
    await user.click(screen.getByTestId('project-space-picker-toggle-workspaces'))
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
    expect(screen.getByTestId('project-space-context-pill')).toHaveFocus()
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
    const cloudOption = projectOptions().getByRole('option', { name: '周报 · 远程项目 · CLOUD' })
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
    const option = projectOptions().getByRole('option', { name: '周报 · 远程项目 · CLOUD' })
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

  test('preserves manual scrolling across project refreshes and scrolls for user navigation', async () => {
    const user = userEvent.setup()
    const projects = Array.from({ length: 40 }, (_, index) => ({
      ...teamProject,
      id: `project-${index}`,
      name: `Project ${index}`,
      project_key: `PROJECT-${index}`,
    }))
    const props = { project: projects[0], projects, onSelectProject: vi.fn() }
    const { rerender } = render(<WorkItemComposerGuide {...props} />)
    await user.click(screen.getByTestId('project-space-context-pill'))
    const search = screen.getByTestId('project-space-picker-search')
    await waitFor(() => expect(search).toHaveFocus())
    const list = screen.getByRole('listbox')
    const options = projectOptions().getAllByRole('option')
    const scrollIntoView = vi.fn(function (this: HTMLElement) {
      list.scrollTop = options.indexOf(this) * 48
    })
    options.forEach(option => {
      option.scrollIntoView = scrollIntoView
    })
    list.scrollTop = 48 * 32
    fireEvent.scroll(list)

    rerender(
      <WorkItemComposerGuide {...props} projects={projects.map(option => ({ ...option }))} />
    )

    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(list.scrollTop).toBe(48 * 32)
    await user.keyboard('{ArrowDown}')
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(options[1])
    expect(search).toHaveAttribute('aria-activedescendant', options[1].id)
    await user.selectOptions(screen.getByTestId('project-space-picker-sort'), 'name-desc')
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(options[39])
    await user.type(search, 'Project 25')
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(options[25])
  })

  test('restores focus for keyboard dismissal and preserves native focus on outside clicks', async () => {
    const user = userEvent.setup()
    const onSelectProject = vi.fn()
    render(
      <>
        <WorkItemComposerGuide
          project={project}
          projects={pickerProjects}
          onSelectProject={onSelectProject}
        />
        <button type="button">Outside action</button>
      </>
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

    await user.click(trigger)
    await waitFor(() => expect(screen.getByTestId('project-space-picker-search')).toHaveFocus())
    await user.click(document.body)
    expect(screen.queryByTestId('work-item-context-menu')).not.toBeInTheDocument()
    expect(document.body).toHaveFocus()

    await user.click(trigger)
    await waitFor(() => expect(screen.getByTestId('project-space-picker-search')).toHaveFocus())
    const outsideAction = screen.getByRole('button', { name: 'Outside action' })
    await user.click(outsideAction)
    expect(screen.queryByTestId('work-item-context-menu')).not.toBeInTheDocument()
    expect(outsideAction).toHaveFocus()
  })
})
