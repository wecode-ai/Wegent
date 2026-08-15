import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { ProjectSpaceApi } from '@/features/todo/projectSpaceSelection'
import { WorkItemComposerGuide } from './WorkItemComposerGuide'

const project = {
  id: 'work-items',
  project_key: 'WORK',
  name: '我的任务',
  project_store: 'local',
} as CloudProject

const item = {
  id: 'WORK-1',
  title: '完成默认工作项流程',
  status: 'in_review',
  assignee_name: '张三',
  assignee_agent_name: null,
  ai_state: null,
} as CloudLoopItem

describe('WorkItemComposerGuide', () => {
  test('shows the default board as a dropdown before the task is created', async () => {
    const user = userEvent.setup()
    render(<WorkItemComposerGuide project={project} />)

    expect(screen.getByTestId('project-space-context-pill')).toHaveTextContent('我的任务')
    expect(screen.getByTestId('work-item-guide-summary-pending')).toHaveTextContent(
      '发送后自动创建，并同步任务进展'
    )
    await user.click(screen.getByTestId('project-space-context-pill'))
    expect(screen.getByTestId('work-item-context-menu')).toHaveTextContent(
      '发送后自动创建，并同步任务进展'
    )
    await waitFor(() =>
      expect(screen.getByTestId('work-item-project-option-work-items')).toHaveFocus()
    )
  })

  test('summarizes the next step, related tasks, and participants', async () => {
    const api = {
      listTaskBindings: vi.fn().mockResolvedValue([
        { id: 1, task_user_id: 7 },
        { id: 2, task_user_id: 7 },
      ]),
      listLoopItemCollaborators: vi.fn().mockResolvedValue([{ id: '1', user_name: '李四' }]),
      findCloudContextForTask: vi.fn().mockResolvedValue({
        project,
        loop_item: item,
      }),
    } as unknown as ProjectSpaceApi

    render(
      <WorkItemComposerGuide
        project={project}
        item={item}
        api={api}
        currentTask={{ deviceId: 'local-device', taskId: 'runtime-1' }}
        currentUserName="王五"
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId('work-item-guide-summary-details')).toHaveTextContent('2 个任务')
    )
    expect(screen.getByTestId('work-item-guide-summary-title')).toHaveTextContent(
      '完成默认工作项流程'
    )
    expect(screen.getByTestId('work-item-guide-summary-next-step')).toHaveTextContent(
      '下一步：验收结果'
    )
    expect(screen.getByTestId('work-item-guide-summary-participants')).toHaveTextContent(
      '张三、王五 +1'
    )

    const user = userEvent.setup()
    await user.click(screen.getByTestId('project-space-context-pill'))
    expect(screen.getByTestId('work-item-guide-next-step')).toHaveTextContent('下一步：验收结果')
    expect(screen.getByTestId('work-item-guide-details')).toHaveTextContent('2 个任务')
    expect(screen.getByTestId('work-item-guide-participants')).toHaveTextContent('张三、王五 +1')
  })

  test('opens the work-item context from its dropdown action', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(<WorkItemComposerGuide project={project} item={item} onOpen={onOpen} />)

    await user.click(screen.getByTestId('project-space-context-pill'))
    await user.click(screen.getByTestId('work-item-open-details'))

    expect(onOpen).toHaveBeenCalledOnce()
  })

  test('selects another board from the dropdown before sending', async () => {
    const user = userEvent.setup()
    const anotherProject = {
      ...project,
      id: 'team-board',
      project_key: 'TEAM',
      name: '团队协作',
    } as CloudProject
    const onSelectProject = vi.fn()
    render(
      <WorkItemComposerGuide
        project={project}
        projects={[project, anotherProject]}
        onSelectProject={onSelectProject}
      />
    )

    await user.click(screen.getByTestId('project-space-context-pill'))
    await user.click(screen.getByTestId('work-item-project-option-team-board'))

    expect(onSelectProject).toHaveBeenCalledWith(anotherProject)
    expect(screen.queryByTestId('work-item-context-menu')).not.toBeInTheDocument()
  })
})
