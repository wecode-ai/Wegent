import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { NotificationIssueEntity } from './NotificationIssueEntity'
import '@/i18n'
import { openWeworkScheme } from './schemeEvents'

vi.mock('./schemeEvents', () => ({ openWeworkScheme: vi.fn() }))

const host = vi.hoisted(() => ({
  userId: 1,
  localGroup: { get: vi.fn() },
  cloudGroup: { get: vi.fn() },
  local: { listCloudProjects: vi.fn(), getLoopItem: vi.fn() },
  cloud: { listCloudProjects: vi.fn(), getLoopItem: vi.fn() },
  render: vi.fn(),
}))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    state: { user: { id: host.userId }, devices: [], projects: [] },
    services: {
      projectSpaceApis: { local: host.local, cloud: host.cloud },
      chatGroupApis: { local: host.localGroup, cloud: host.cloudGroup },
    },
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
  host.userId = 1
  host.local.listCloudProjects.mockResolvedValue({ items: [project] })
  host.local.getLoopItem.mockResolvedValue(item)
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

it.each(['local', 'backend'] as const)(
  'resolves a %s Group-owned Thread without querying the Project catalog',
  async store => {
    const api = store === 'local' ? host.local : host.cloud
    const groups = store === 'local' ? host.localGroup : host.cloudGroup
    const group = {
      id: '42',
      project_key: 'GROUP',
      name: 'Real group',
      description: '',
      role: 'Viewer',
      status: 'active',
      version: 1,
      created_by_user_id: 5,
      created_at: '',
      updated_at: '',
    }
    const thread = { ...item, group_id: '42', cloud_project_id: '42' }
    api.getLoopItem.mockResolvedValue(thread)
    groups.get.mockResolvedValue({ group, members: [] })
    render(
      <NotificationIssueEntity
        {...props}
        projectId="42"
        store={store}
        url={'wework://groups/' + store + '/42/threads/ISSUE-1'}
      />
    )
    await screen.findByTestId('real-issue')
    expect(groups.get).toHaveBeenCalledExactlyOnceWith('42')
    expect(api.listCloudProjects).not.toHaveBeenCalled()
    const panel = host.render.mock.lastCall?.[0] as { onOpenChildTask(item: typeof thread): void }
    panel.onOpenChildTask({ ...thread, id: 'CHILD-2' })
    expect(openWeworkScheme).toHaveBeenLastCalledWith(
      'wework://groups/' + store + '/42/threads/CHILD-2'
    )
    expect(host.render).toHaveBeenLastCalledWith(
      expect.objectContaining({
        item: thread,
        project: expect.objectContaining({
          id: '42',
          name: 'Real group',
          resource_type: 'chat_group',
          access_role: 'Viewer',
        }),
      })
    )
  }
)

it('does not fall back to a classification Project when Group membership is denied', async () => {
  host.local.getLoopItem.mockResolvedValue({ ...item, group_id: '42', cloud_project_id: '42' })
  host.localGroup.get.mockRejectedValue(new Error('Group access revoked'))
  render(<NotificationIssueEntity {...props} projectId="42" />)
  await screen.findByRole('alert')
  expect(host.local.listCloudProjects).not.toHaveBeenCalled()
  expect(host.render).not.toHaveBeenCalled()
})

it('rejects disagreement between Group identity and the destination owner', async () => {
  host.local.getLoopItem.mockResolvedValue({ ...item, group_id: '42' })
  render(<NotificationIssueEntity {...props} />)
  await screen.findByRole('alert')
  expect(host.localGroup.get).not.toHaveBeenCalled()
  expect(host.local.listCloudProjects).not.toHaveBeenCalled()
  expect(host.render).not.toHaveBeenCalled()
})

it('removes old account content immediately while reloading the same destination', async () => {
  const mounted = render(<NotificationIssueEntity {...props} />)
  await screen.findByTestId('real-issue')
  let resolve!: (value: typeof item) => void
  host.local.getLoopItem.mockReturnValueOnce(
    new Promise<typeof item>(accept => {
      resolve = accept
    })
  )
  host.userId = 2
  mounted.rerender(<NotificationIssueEntity {...props} />)
  expect(screen.queryByTestId('real-issue')).toBeNull()
  await act(async () => {
    resolve({ ...item, title: 'Current account only' })
  })
  await screen.findByTestId('real-issue')
  expect(host.render).toHaveBeenLastCalledWith(
    expect.objectContaining({
      currentUserId: 2,
      item: expect.objectContaining({ title: 'Current account only' }),
    })
  )
})
