import '@/i18n'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WeworkSharedProject } from './WeworkCollaborationPlatform'
import type { TodoEditor } from './TodoEditor'
import type { AiChatModal } from './AiChatModal'

vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => false,
}))
vi.mock('./TodoEditor', () => ({
  TodoEditor: (props: ComponentProps<typeof TodoEditor>) => (
    <>
      <button data-testid="create-personal-task" onClick={props.onCreateTask}>
        Create personal task
      </button>
      <button
        data-testid="existing-task"
        onClick={() =>
          void props.onOpenTaskConversation?.({ device_id: 'device', task_id: 'existing' } as never)
        }
      >
        Existing task
      </button>
    </>
  ),
}))
vi.mock('./AiChatModal', () => ({
  AiChatModal: (props: ComponentProps<typeof AiChatModal>) => (
    <div
      data-testid="shared-board-conversation"
      data-task={props.initialAddress?.taskId ?? 'new'}
      data-input={props.initialTaskInput}
    >
      <button onClick={props.onClose}>Close conversation</button>
    </div>
  ),
}))
const originalGetAnimations = Element.prototype.getAnimations
beforeEach(() => {
  Element.prototype.getAnimations = vi.fn(() => [])
})
afterEach(() => {
  cleanup()
  if (originalGetAnimations) Element.prototype.getAnimations = originalGetAnimations
  else Reflect.deleteProperty(Element.prototype, 'getAnimations')
})

function setup() {
  const issue = {
    id: 'one',
    cloud_project_id: 'p1',
    title: 'Issue',
    assignee_user_id: 7,
    version: 1,
  }
  const setLocation = vi.fn()
  const onExpandedChange = vi.fn()
  const binding = {
    projectId: 'p1',
    issueId: 'one',
    deviceId: 'device',
    taskId: 'existing',
    taskUserId: 7,
  }
  const props = {
    api: {
      projects: {},
      issues: { get: vi.fn().mockResolvedValue(issue), list: vi.fn().mockResolvedValue([issue]) },
      assignments: { list: vi.fn().mockResolvedValue([]) },
      taskBindings: { list: vi.fn().mockResolvedValue([binding]) },
    },
    project: { id: 'p1', name: 'Project', project_store: 'backend' },
    personalIssue: {
      issue,
      project: { id: 'p1', project_store: 'backend' },
      active: true,
      onUpdated: vi.fn(),
      onOpenIssue: vi.fn(),
      onClose: vi.fn(),
      onExpandedChange,
    },
    localProjects: [],
    locale: 'en',
    location: { projectId: null, projectView: 'board', issueId: null },
    services: {
      standInApi: {
        deviceIdentity: vi.fn().mockResolvedValue({ backendDeviceId: 'device' }),
        readTask: vi.fn().mockResolvedValue({ success: true }),
      },
    },
    userId: 7,
    workspace: { id: 'w1', name: 'Workspace' },
    setLocation,
    runtimePort: { bindTask: vi.fn(), unbindTask: vi.fn() },
  } as unknown as ComponentProps<typeof WeworkSharedProject>
  return { ...render(<WeworkSharedProject {...props} />), props, setLocation, onExpandedChange }
}
it('uses the board task creation flow inline and expands only the surrounding home workspace', async () => {
  const { setLocation, onExpandedChange } = setup()
  fireEvent.click(await screen.findByTestId('create-personal-task'))
  expect(await screen.findByTestId('shared-board-conversation')).toHaveAttribute('data-task', 'new')
  await waitFor(() => expect(onExpandedChange).toHaveBeenLastCalledWith(true))
  expect(setLocation).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Close conversation'))
  await waitFor(() => expect(onExpandedChange).toHaveBeenLastCalledWith(false))
  expect(screen.getByTestId('create-personal-task')).toBeInTheDocument()
})
it('uses the board availability and ownership checks before opening a bound task in the second pane', async () => {
  const { props, setLocation } = setup()
  fireEvent.click(await screen.findByTestId('existing-task'))
  expect(await screen.findByTestId('shared-board-conversation')).toHaveAttribute(
    'data-task',
    'existing'
  )
  expect(props.services.standInApi?.readTask).toHaveBeenCalledWith('device', 'existing')
  expect(props.services.standInApi?.deviceIdentity).toHaveBeenCalledWith('device')
  expect(setLocation).not.toHaveBeenCalled()
})

it('opens an explicitly created task in the new Issue using the existing availability checks', async () => {
  const { props, rerender, setLocation } = setup()
  rerender(
    <WeworkSharedProject
      {...props}
      personalIssue={{
        ...props.personalIssue!,
        taskRequest: { key: 'created-once', address: { deviceId: 'device', taskId: 'existing' } },
      }}
    />
  )
  const pane = await screen.findByTestId('shared-board-conversation')
  expect(pane).toHaveAttribute('data-task', 'existing')
  expect(props.services.standInApi?.readTask).toHaveBeenCalledWith('device', 'existing')
  expect(props.services.standInApi?.deviceIdentity).toHaveBeenCalledWith('device')
  expect(setLocation).not.toHaveBeenCalled()
})
