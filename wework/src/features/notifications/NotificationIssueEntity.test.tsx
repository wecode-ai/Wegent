import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { NotificationIssueEntity } from './NotificationIssueEntity'
import '@/i18n'

const host = vi.hoisted(() => ({
  local: { listCloudProjects: vi.fn(), getLoopItem: vi.fn() },
  cloud: { listCloudProjects: vi.fn(), getLoopItem: vi.fn() },
  render: vi.fn(),
}))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    state: { user: { id: 1 }, devices: [], projects: [] },
    services: { projectSpaceApis: { local: host.local, cloud: host.cloud } },
  }),
}))
vi.mock('@/features/todo/WorkItemContextPanel', () => ({
  WorkItemContextPanel: (props: unknown) => {
    host.render(props)
    return <div data-testid="real-issue" />
  },
}))
const project = { id: 'project', project_store: 'local' }
const item = {
  id: 'ISSUE-1',
  cloud_project_id: 'project',
  title: 'Actual title',
  description: 'Actual body',
}
const props = {
  projectId: 'project',
  issueId: 'ISSUE-1',
  store: 'local' as const,
  url: 'wework://boards/local/project/issues/ISSUE-1',
  commentId: 'root',
  address: { deviceId: 'device', taskId: 'task' },
  active: true,
}
beforeEach(() => {
  vi.clearAllMocks()
  host.local.listCloudProjects.mockResolvedValue({ items: [project] })
  host.local.getLoopItem.mockResolvedValue(item)
})
it('loads exact records from their owning store and passes them unchanged to the native detail', async () => {
  render(<NotificationIssueEntity {...props} />)
  await screen.findByTestId('real-issue')
  expect(host.local.getLoopItem).toHaveBeenCalledExactlyOnceWith('ISSUE-1')
  expect(host.cloud.getLoopItem).not.toHaveBeenCalled()
  expect(host.render).toHaveBeenLastCalledWith(
    expect.objectContaining({ project, item, focusedCommentId: 'root' })
  )
})
it('rejects an Issue returned from a different project', async () => {
  host.local.getLoopItem.mockResolvedValue({ ...item, cloud_project_id: 'other-project' })
  render(<NotificationIssueEntity {...props} />)
  await screen.findByRole('alert')
  expect(host.render).not.toHaveBeenCalled()
})
it('does not start entity requests from an inactive notification page', async () => {
  const { rerender } = render(<NotificationIssueEntity {...props} active={false} />)
  expect(host.local.getLoopItem).not.toHaveBeenCalled()
  rerender(<NotificationIssueEntity {...props} />)
  await waitFor(() => expect(host.local.getLoopItem).toHaveBeenCalledOnce())
})
it('retries the same owning entity after a transient load failure', async () => {
  host.local.getLoopItem.mockRejectedValueOnce(new Error('Disconnected'))
  render(<NotificationIssueEntity {...props} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Disconnected')
  fireEvent.click(screen.getByTestId('notification-entity-retry'))
  await screen.findByTestId('real-issue')
  expect(host.local.getLoopItem).toHaveBeenCalledTimes(2)
  expect(host.cloud.getLoopItem).not.toHaveBeenCalled()
})
