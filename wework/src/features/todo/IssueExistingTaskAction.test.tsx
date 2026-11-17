import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { CloudLoopItem } from '@/api/deliveries'
import type { RuntimeWorkListResponse } from '@/types/api'
import { IssueExistingTaskAction } from './IssueExistingTaskAction'

const issue = {
  id: 'ISSUE-1',
  cloud_project_id: 'project',
  project_store: 'backend',
} as CloudLoopItem
const work = {
  projects: [],
  chats: [
    {
      deviceId: 'device',
      workspacePath: '/repo',
      tasks: [{ taskId: 'task', title: 'Existing task', runtime: 'codex' }],
    },
  ],
} as unknown as RuntimeWorkListResponse

describe('IssueExistingTaskAction', () => {
  it('uses the supplied store port and refreshes the shared editor after linking', async () => {
    const port = { bindTask: vi.fn().mockResolvedValue(undefined), unbindTask: vi.fn() }
    const onLinked = vi.fn()
    const user = userEvent.setup()
    render(
      <IssueExistingTaskAction
        source={{ work, port }}
        issue={issue}
        project={{ projectStore: 'backend', projectId: 'project' }}
        bindings={[]}
        onLinked={onLinked}
      />
    )
    await user.click(screen.getByTestId('issue-link-existing-task'))
    await user.click(screen.getByText('Existing task'))
    await waitFor(() => expect(onLinked).toHaveBeenCalledOnce())
    expect(port.bindTask).toHaveBeenCalledWith(
      'ISSUE-1',
      expect.objectContaining({ deviceId: 'device', taskId: 'task' }),
      'Existing task',
      null
    )
    await user.click(screen.getByTestId('issue-link-existing-task'))
    expect(screen.queryByText('Existing task')).not.toBeInTheDocument()
  })
})
