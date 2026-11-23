import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { CloudLoopItem } from '@/api/deliveries'
import '@/i18n'
import type { RuntimeDeviceWorkspace, RuntimeTaskSummary } from '@/types/api'
import { IssueExistingTaskAction } from './IssueExistingTaskAction'

function workspace(
  deviceId: string,
  taskId: string,
  timestamps: Pick<RuntimeTaskSummary, 'recencyAt' | 'updatedAt' | 'createdAt'>
): RuntimeDeviceWorkspace {
  const workspacePath = `/workspaces/${deviceId}`
  return {
    deviceId,
    available: true,
    workspacePath,
    tasks: [{ taskId, title: taskId, runtime: 'codex', workspacePath, ...timestamps }],
  }
}

it('shows the latest activity first across projects and chats and preserves it when searching', async () => {
  const user = userEvent.setup()
  render(
    <IssueExistingTaskAction
      source={{
        work: {
          projects: [
            {
              project: { key: 'local', name: 'Local project' },
              deviceWorkspaces: [
                workspace('local', 'release-project', {
                  recencyAt: '2026-11-21T12:00:00Z',
                  updatedAt: '2026-11-23T15:00:00Z',
                }),
              ],
            },
            {
              project: { key: 'remote', name: 'Remote project' },
              deviceWorkspaces: [
                workspace('remote', 'review', { createdAt: '2026-11-22T12:00:00Z' }),
              ],
            },
          ],
          chats: [workspace('local', 'release-chat', { updatedAt: Date.UTC(2026, 10, 23) })],
          totalTasks: 3,
        },
        port: { bindTask: vi.fn(), unbindTask: vi.fn() },
      }}
      issue={{ id: 'ISSUE-1' } as CloudLoopItem}
      project={{ projectStore: 'local', projectId: 'project' }}
      bindings={[]}
      onLinked={vi.fn()}
    />
  )

  await user.click(screen.getByTestId('issue-link-existing-task'))
  const picker = within(screen.getByTestId('issue-existing-task-picker'))
  const taskOrder = () => picker.getAllByRole('button').map(button => button.dataset.testid)
  expect(taskOrder()).toEqual([
    'issue-existing-task-local-release-chat',
    'issue-existing-task-remote-review',
    'issue-existing-task-local-release-project',
  ])

  await user.type(picker.getByTestId('issue-existing-task-search'), 'release')
  expect(taskOrder()).toEqual([
    'issue-existing-task-local-release-chat',
    'issue-existing-task-local-release-project',
  ])
})
