import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { TaskChangeRequestSnapshot } from '@/api/changeRequests'
import type { CloudLoopItem } from '@/api/deliveries'
import { CloudTodoBoardCard } from './CloudTodoBoardCard'

const changeRequestMonitorMocks = vi.hoisted(() => ({
  useTaskChangeRequest: vi.fn(),
}))

vi.mock('@/features/workbench/changeRequestMonitor', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/workbench/changeRequestMonitor')>()
  return {
    ...actual,
    useTaskChangeRequest: changeRequestMonitorMocks.useTaskChangeRequest,
  }
})

const item = {
  id: 'WEG-85',
  title: 'Keep the pull request popup visible',
  description: null,
  status: 'in_review',
  priority: 'none',
  can_edit: true,
  can_view_detail: true,
  updated_at: '2026-08-21T00:00:00Z',
} as CloudLoopItem

const snapshot: TaskChangeRequestSnapshot = {
  target: {
    deviceId: 'local',
    taskId: 'task-85',
    workspacePath: '/workspace',
    remoteUrl: 'https://github.com/wecode-ai/Wegent.git',
    branch: 'fix/board-pr-popup',
  },
  changeRequest: {
    provider: 'github',
    number: 85,
    url: 'https://github.com/wecode-ai/Wegent/pull/85',
    title: 'Keep the pull request popup visible',
    state: 'open',
    draft: false,
    checks: 'pending',
    mergeability: 'unknown',
    mergeQueue: 'not_queued',
  },
  fetchedAt: '2026-08-21T00:00:00Z',
  stale: false,
  error: null,
}

describe('CloudTodoBoardCard', () => {
  it('renders the pull request popup outside the overflow-hidden board card', async () => {
    changeRequestMonitorMocks.useTaskChangeRequest.mockReturnValue(snapshot)

    render(
      <CloudTodoBoardCard
        item={item}
        taskBindings={[
          {
            id: 85,
            device_id: 'local',
            task_id: 'task-85',
            task_title: 'Fix the board popup',
            running: false,
            changeRequestTarget: snapshot.target,
            finalResponseLoaded: true,
          },
        ]}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        display={{
          showAssignee: false,
          showPriority: false,
          showTags: false,
          showDate: false,
        }}
      />
    )

    await userEvent.click(screen.getByTestId('cloud-todo-card-change-request-WEG-85-85'))

    const popover = screen.getByTestId('cloud-todo-card-change-request-WEG-85-85-popover')
    expect(popover.parentElement).toBe(document.body)
    expect(popover).toHaveClass('fixed', 'z-system-popover')
  })

  it('keeps repeated task text out of the card and narrows the full-card hover preview', async () => {
    render(
      <CloudTodoBoardCard
        item={{ ...item, description: 'This description must be hidden from the card' }}
        taskBindings={[
          {
            id: 85,
            device_id: 'local',
            task_id: 'task-85',
            task_title: 'Fix the board popup',
            running: true,
            finalResponsePreview: '已定位第一个任务的当前回复',
          },
          {
            id: 86,
            device_id: 'local',
            task_id: 'task-86',
            task_title: 'Verify the hover behavior',
            running: true,
            finalResponsePreview: '正在校验第二个任务的运行过程',
          },
        ]}
        onClick={vi.fn()}
        onArchive={vi.fn()}
        display={{
          showAssignee: false,
          showPriority: false,
          showTags: false,
          showDate: false,
        }}
      />
    )

    const card = screen.getByTestId('cloud-todo-card-WEG-85')
    expect(card).not.toHaveTextContent('This description must be hidden from the card')
    expect(screen.getByTestId('cloud-todo-card-tasks-WEG-85')).not.toHaveTextContent(
      'Fix the board popup'
    )

    fireEvent.mouseEnter(card)
    const popup = await screen.findByTestId('cloud-todo-card-progress-popup-WEG-85')
    expect(popup).toHaveTextContent('Fix the board popup')
    expect(popup).toHaveTextContent('Verify the hover behavior')

    fireEvent.mouseEnter(screen.getByTestId('cloud-todo-card-progress-task-WEG-85-86'))
    expect(screen.queryByText('Fix the board popup')).not.toBeInTheDocument()
    expect(screen.getByText('Verify the hover behavior')).toBeInTheDocument()
  })
})
