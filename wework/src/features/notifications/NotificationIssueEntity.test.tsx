import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { NotificationIssueEntity } from './NotificationIssueEntity'
import '@/i18n'
import { openWeworkScheme } from './schemeEvents'

vi.mock('./schemeEvents', () => ({ openWeworkScheme: vi.fn() }))

const host = vi.hoisted(() => ({
  userId: 1,
  local: { listCloudProjects: vi.fn(), getLoopItem: vi.fn() },
  cloud: { listCloudProjects: vi.fn(), getLoopItem: vi.fn() },
  render: vi.fn(),
}))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    state: { user: { id: host.userId }, devices: [], projects: [] },
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
const initialLocalApi = host.local
const initialCloudApi = host.cloud
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}
beforeEach(() => {
  host.userId = 1
  host.local = initialLocalApi
  host.cloud = initialCloudApi
  vi.clearAllMocks()
  host.local.listCloudProjects.mockReset().mockResolvedValue({ items: [project] })
  host.local.getLoopItem.mockReset().mockResolvedValue(item)
  host.cloud.listCloudProjects
    .mockReset()
    .mockResolvedValue({ items: [{ ...project, project_store: 'backend' }] })
  host.cloud.getLoopItem.mockReset().mockResolvedValue(item)
})
it('loads exact records from their owning store and passes them unchanged to the native detail', async () => {
  render(<NotificationIssueEntity {...props} />)
  await screen.findByTestId('real-issue')
  expect(host.local.getLoopItem).toHaveBeenCalledExactlyOnceWith('ISSUE-1')
  expect(host.cloud.getLoopItem).not.toHaveBeenCalled()
  expect(host.render).toHaveBeenLastCalledWith(
    expect.objectContaining({
      project,
      item,
      currentUserId: 1,
      focusedCommentId: 'root',
      readFirst: true,
    })
  )
})
it('retains the authenticated cloud identity when opening a backend Issue', async () => {
  host.cloud.listCloudProjects.mockResolvedValue({
    items: [{ ...project, project_store: 'backend' }],
  })
  host.cloud.getLoopItem.mockResolvedValue(item)
  render(
    <NotificationIssueEntity
      {...props}
      store="backend"
      url="wework://boards/cloud/project/issues/ISSUE-1"
    />
  )
  await screen.findByTestId('real-issue')
  expect(host.render).toHaveBeenLastCalledWith(expect.objectContaining({ currentUserId: 1 }))
  expect(host.local.getLoopItem).not.toHaveBeenCalled()
})
it('rejects an Issue returned from a different project', async () => {
  host.local.getLoopItem.mockResolvedValue({ ...item, cloud_project_id: 'other-project' })
  render(<NotificationIssueEntity {...props} />)
  await screen.findByRole('alert')
  expect(host.render).not.toHaveBeenCalled()
})

it('hands execution and child Issue navigation to original pages without a duplicate header action', async () => {
  render(<NotificationIssueEntity {...props} />)
  await screen.findByTestId('real-issue')
  const panel = host.render.mock.lastCall?.[0] as {
    onOpenBoard?: () => void
    onOpenRuntimeTask: (address: { deviceId: string; taskId: string }) => void
    onOpenChildTask: (item: { id: string }) => void
  }
  expect(panel.onOpenBoard).toBeUndefined()
  panel.onOpenRuntimeTask({ deviceId: 'another-device', taskId: 'actual-execution' })
  expect(openWeworkScheme).toHaveBeenLastCalledWith(
    'wework://tasks/another-device/actual-execution'
  )
  panel.onOpenChildTask({ id: 'CHILD-2' })
  expect(openWeworkScheme).toHaveBeenLastCalledWith('wework://boards/local/project/issues/CHILD-2')
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

it('hides old records when the API owner changes while the destination URL stays the same', async () => {
  const { rerender } = render(<NotificationIssueEntity {...props} />)
  await screen.findByTestId('real-issue')
  const pending = deferred<typeof item>()
  const nextApi = {
    listCloudProjects: vi.fn().mockResolvedValue({ items: [project] }),
    getLoopItem: vi.fn(() => pending.promise),
  }
  host.local = nextApi
  rerender(<NotificationIssueEntity {...props} />)
  expect(screen.queryByTestId('real-issue')).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toBeInTheDocument()
  const nextItem = { ...item, title: 'New owner record' }
  await act(async () => pending.resolve(nextItem))
  await screen.findByTestId('real-issue')
  expect(host.render).toHaveBeenLastCalledWith(
    expect.objectContaining({ api: nextApi, item: nextItem })
  )
})

it('ignores late records from an old API owner with the same destination URL', async () => {
  const pending = deferred<typeof item>()
  host.local.getLoopItem.mockReturnValueOnce(pending.promise)
  const { rerender } = render(<NotificationIssueEntity {...props} />)
  const nextItem = { ...item, title: 'Current owner record' }
  host.local = {
    listCloudProjects: vi.fn().mockResolvedValue({ items: [project] }),
    getLoopItem: vi.fn().mockResolvedValue(nextItem),
  }
  rerender(<NotificationIssueEntity {...props} />)
  await screen.findByTestId('real-issue')
  await act(async () => pending.resolve(item))
  expect(host.render).toHaveBeenLastCalledWith(expect.objectContaining({ item: nextItem }))
})

it('does not retain a previous store error when the destination is loaded from another store', async () => {
  host.local.getLoopItem.mockRejectedValueOnce(new Error('Local source failed'))
  const { rerender } = render(<NotificationIssueEntity {...props} />)
  await screen.findByRole('alert')
  rerender(<NotificationIssueEntity {...props} store="backend" />)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  await screen.findByTestId('real-issue')
  expect(host.cloud.getLoopItem).toHaveBeenCalledExactlyOnceWith('ISSUE-1')
  expect(host.render).toHaveBeenLastCalledWith(expect.objectContaining({ api: host.cloud }))
})

it('cancels ownership on deactivation and reads fresh records when activated again', async () => {
  const pending = deferred<typeof item>()
  host.local.getLoopItem.mockReturnValueOnce(pending.promise)
  const { rerender } = render(<NotificationIssueEntity {...props} />)
  rerender(<NotificationIssueEntity {...props} active={false} />)
  await act(async () => pending.resolve(item))
  expect(host.render).not.toHaveBeenCalled()
  const nextItem = { ...item, title: 'Fresh after activation' }
  host.local.getLoopItem.mockResolvedValue(nextItem)
  rerender(<NotificationIssueEntity {...props} />)
  await screen.findByTestId('real-issue')
  expect(host.local.getLoopItem).toHaveBeenCalledTimes(2)
  expect(host.render).toHaveBeenLastCalledWith(expect.objectContaining({ item: nextItem }))
})

it('keeps a valid same-owner detail mounted while activation refreshes its records', async () => {
  const { rerender } = render(<NotificationIssueEntity {...props} />)
  const panel = await screen.findByTestId('real-issue')
  rerender(<NotificationIssueEntity {...props} active={false} />)
  const pending = deferred<typeof item>()
  host.local.getLoopItem.mockReturnValueOnce(pending.promise)
  rerender(<NotificationIssueEntity {...props} />)
  expect(screen.getByTestId('real-issue')).toBe(panel)
  expect(host.local.getLoopItem).toHaveBeenCalledTimes(2)
  await act(async () => pending.resolve({ ...item, title: 'Refreshed record' }))
  expect(screen.getByTestId('real-issue')).toBe(panel)
})

it('revalidates project ownership when the project changes even if the URL is unchanged', async () => {
  const { rerender } = render(<NotificationIssueEntity {...props} />)
  await screen.findByTestId('real-issue')
  host.local.listCloudProjects.mockResolvedValue({ items: [{ ...project, id: 'other-project' }] })
  rerender(<NotificationIssueEntity {...props} projectId="other-project" />)
  expect(screen.queryByTestId('real-issue')).not.toBeInTheDocument()
  await screen.findByRole('alert')
  expect(screen.queryByTestId('real-issue')).not.toBeInTheDocument()
})

it('ignores a late old-source error after a new owner has loaded the record', async () => {
  const pending = deferred<typeof item>()
  host.local.getLoopItem.mockReturnValueOnce(pending.promise)
  const { rerender } = render(<NotificationIssueEntity {...props} />)
  host.local = {
    listCloudProjects: vi.fn().mockResolvedValue({ items: [project] }),
    getLoopItem: vi.fn().mockResolvedValue(item),
  }
  rerender(<NotificationIssueEntity {...props} />)
  await screen.findByTestId('real-issue')
  await act(async () => pending.reject(new Error('Old owner disconnected')))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByTestId('real-issue')).toBeInTheDocument()
})

it('shows an actionable error even when the failed request supplies an empty message', async () => {
  host.local.getLoopItem.mockRejectedValueOnce(new Error(''))
  render(<NotificationIssueEntity {...props} />)
  expect((await screen.findByRole('alert')).textContent?.trim().length).toBeGreaterThan(0)
  expect(screen.getByTestId('notification-entity-retry')).toBeEnabled()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

it('drops cached records when the authenticated user changes with the same API and URL', async () => {
  const { rerender } = render(<NotificationIssueEntity {...props} />)
  await screen.findByTestId('real-issue')
  const pending = deferred<typeof item>()
  host.local.getLoopItem.mockReturnValueOnce(pending.promise)
  host.userId = 2
  rerender(<NotificationIssueEntity {...props} />)
  expect(screen.queryByTestId('real-issue')).not.toBeInTheDocument()
  const nextItem = { ...item, title: 'Second user record' }
  await act(async () => pending.resolve(nextItem))
  await screen.findByTestId('real-issue')
  expect(host.render).toHaveBeenLastCalledWith(
    expect.objectContaining({ currentUserId: 2, item: nextItem })
  )
  expect(host.local.getLoopItem).toHaveBeenCalledTimes(2)
})

it('updates comment focus without reloading an unchanged owning Issue', async () => {
  const { rerender } = render(<NotificationIssueEntity {...props} />)
  await screen.findByTestId('real-issue')
  const nextUrl = props.url + '/comments/next-comment'
  rerender(<NotificationIssueEntity {...props} url={nextUrl} commentId="next-comment" />)
  expect(screen.getByTestId('real-issue')).toBeInTheDocument()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(host.local.getLoopItem).toHaveBeenCalledTimes(1)
  expect(host.local.listCloudProjects).toHaveBeenCalledTimes(1)
  expect(host.render).toHaveBeenLastCalledWith(
    expect.objectContaining({ focusedCommentId: 'next-comment', focusedCommentRequestKey: nextUrl })
  )
})
