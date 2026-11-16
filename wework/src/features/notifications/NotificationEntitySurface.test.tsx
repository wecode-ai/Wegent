import { render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { NotificationEntitySurface } from './NotificationEntitySurface'
import { useNotificationEntity } from './NotificationEntityContext'

const hosts = vi.hoisted(() => ({
  task: vi.fn(),
  issue: vi.fn(),
  context: vi.fn(),
  bootstrapping: false,
}))
beforeEach(() => {
  vi.clearAllMocks()
  hosts.bootstrapping = false
})
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    state: {
      user: { id: 1 },
      devices: [],
      projects: [],
      runtimeWork: null,
      isBootstrapping: hosts.bootstrapping,
    },
    services: {},
  }),
}))
vi.mock('@/features/workbench/runtimeTaskLifecycle', () => ({
  useRuntimeTaskLifecycleStoreSnapshot: () => ({}),
}))
vi.mock('@/components/layout/workspace-panels/TemporaryChatPanel', () => ({
  TemporaryChatPanel: (props: unknown) => {
    hosts.task(props)
    return <div data-testid="original-task" />
  },
}))
vi.mock('./NotificationIssueEntity', () => ({
  NotificationIssueEntity: (props: unknown) => {
    hosts.issue(props)
    hosts.context(useNotificationEntity())
    return <div data-testid="original-issue" />
  },
}))

it('opens the persistent original task with its existing conversation controls', () => {
  const address = { deviceId: 'device', taskId: 'task', workspacePath: '/workspace' }
  render(<NotificationEntitySurface url="wework://tasks/device/task" address={address} active />)
  expect(screen.getByTestId('original-task')).toBeInTheDocument()
  expect(hosts.task).toHaveBeenLastCalledWith(
    expect.objectContaining({
      initialAddress: address,
      source: address,
      sendEphemeral: false,
      active: true,
    })
  )
})

it('updates original navigation to the message identified by the native Issue view', () => {
  const onOriginalUrlChange = vi.fn()
  render(
    <NotificationEntitySurface
      url="wework://boards/local/project/issues/ISSUE-1/comments/root"
      address={{ deviceId: 'device', taskId: 'task' }}
      interactionId="question-1"
      sourceMessageIds={['source-comment']}
      onOriginalUrlChange={onOriginalUrlChange}
      active
    />
  )
  const scope = hosts.context.mock.lastCall?.[0]
  expect(scope.sourceMessageIds).toEqual(['source-comment'])
  scope.onFocusedMessage('native-ai-message')
  expect(onOriginalUrlChange).toHaveBeenCalledExactlyOnceWith(
    'question-1',
    'wework://boards/local/project/issues/ISSUE-1/comments/native-ai-message'
  )
})

it('waits for the entity provider to resolve device routing before mounting a task', () => {
  hosts.bootstrapping = true
  render(
    <NotificationEntitySurface
      url="wework://tasks/device/task"
      address={{ deviceId: 'device', taskId: 'task' }}
      active
    />
  )
  expect(screen.getByRole('status')).toBeInTheDocument()
  expect(hosts.task).not.toHaveBeenCalled()
})

it('reports an unsupported destination rather than leaving an empty detail pane', () => {
  render(
    <NotificationEntitySurface
      url="wework://unknown/entity"
      address={{ deviceId: 'device', taskId: 'task' }}
      active
    />
  )
  expect(screen.getByRole('status')).not.toBeEmptyDOMElement()
  expect(hosts.task).not.toHaveBeenCalled()
  expect(hosts.issue).not.toHaveBeenCalled()
})

it('opens the owning Issue and comment through the existing collaboration surface', () => {
  render(
    <NotificationEntitySurface
      url="wework://boards/local/project/issues/ISSUE-1/comments/root"
      address={{ deviceId: 'device', taskId: 'task' }}
      active
    />
  )
  expect(screen.getByTestId('original-issue')).toBeInTheDocument()
  expect(hosts.issue).toHaveBeenLastCalledWith(
    expect.objectContaining({
      projectId: 'project',
      store: 'local',
      issueId: 'ISSUE-1',
      commentId: 'root',
    })
  )
})
