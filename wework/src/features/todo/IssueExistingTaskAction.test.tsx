import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { CloudLoopItem } from '@/api/deliveries'
import '@/i18n'
import type { RuntimeWorkListResponse } from '@/types/api'
import { IssueExistingTaskAction } from './IssueExistingTaskAction'

it('only excludes automatic memory reviews from the tasks available to link', async () => {
  const user = userEvent.setup()
  const bindTask = vi.fn().mockResolvedValue(undefined)
  const title = '分身记忆整理'
  const task = { title, runtime: 'codex', workspacePath: '/workspace' } as const
  const automatic = {
    ...task,
    taskId: 'automatic-memory',
    runtimeHandle: { origin: { type: 'stand_in_schedule', memoryReview: true } },
  }
  const manual = { ...task, taskId: 'manual-memory' }
  const weekly = {
    ...task,
    taskId: 'weekly-review',
    title: 'Weekly review',
    runtimeHandle: { origin: { type: 'stand_in_schedule', weeklyReview: true } },
  }
  const workspace = { available: true, workspacePath: task.workspacePath }
  const work: RuntimeWorkListResponse = {
    projects: [
      {
        project: { key: 'workspace', name: 'Workspace' },
        deviceWorkspaces: [{ ...workspace, deviceId: 'local', tasks: [automatic, weekly] }],
      },
    ],
    chats: [{ ...workspace, deviceId: 'remote', tasks: [automatic, manual] }],
    totalTasks: 4,
  }

  render(
    <IssueExistingTaskAction
      source={{ work, port: { bindTask, unbindTask: vi.fn() } }}
      issue={{ id: 'ISSUE-1' } as CloudLoopItem}
      project={{ projectStore: 'backend', projectId: 'project' }}
      bindings={[]}
      onLinked={vi.fn()}
    />
  )

  await user.click(screen.getByTestId('issue-link-existing-task'))
  expect(await screen.findByTestId('issue-existing-task-remote-manual-memory')).toBeVisible()
  expect(screen.getByTestId('issue-existing-task-local-weekly-review')).toBeVisible()
  expect(screen.queryByTestId('issue-existing-task-local-automatic-memory')).toBeNull()
  expect(screen.queryByTestId('issue-existing-task-remote-automatic-memory')).toBeNull()

  const search = screen.getByTestId('issue-existing-task-search')
  await user.type(search, automatic.taskId)
  expect(screen.queryByTestId('issue-existing-task-remote-automatic-memory')).toBeNull()
  await user.clear(search)
  await user.type(search, title)
  await user.click(screen.getByTestId('issue-existing-task-remote-manual-memory'))
  expect(bindTask).toHaveBeenCalledExactlyOnceWith(
    'ISSUE-1',
    expect.objectContaining({ deviceId: 'remote', taskId: manual.taskId }),
    title,
    null
  )
})
