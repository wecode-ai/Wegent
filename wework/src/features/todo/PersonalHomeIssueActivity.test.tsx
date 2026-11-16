import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkspaceTaskBinding } from '@wegent/collaboration'
import { PersonalHomeIssueActivity } from './PersonalHomeIssueActivity'
import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import i18n from '@/i18n'

afterEach(cleanup)

it('keeps a reserved assistant task unavailable until its real Runtime starts', async () => {
  await i18n.changeLanguage('en')
  const pending = { ...binding, standInPending: true }
  const { store, onOpenTask } = mount([pending])
  const row = screen.getByTestId('personal-home-task-issue-binding')
  expect(row).toBeDisabled()
  expect(row).toHaveTextContent('Waiting for assistant')
  fireEvent.click(row)
  expect(onOpenTask).not.toHaveBeenCalled()
  act(() => store.executorStarted(binding))
  expect(row).toBeEnabled()
  expect(row).toHaveTextContent('Running')
  fireEvent.click(row)
  expect(onOpenTask).toHaveBeenCalledExactlyOnceWith(pending)
})
const binding: WorkspaceTaskBinding = {
  id: 'binding',
  projectId: 'project',
  issueId: 'issue',
  taskId: 'task',
  deviceId: 'device',
  taskUserId: 1,
  backendTaskId: null,
  linkedAt: '2026-11-12T00:00:00Z',
  taskTitle: 'Implementation',
}
function mount(
  bindings: WorkspaceTaskBinding[] = [],
  assignment?: { body: string; created_by_user_name: string; created_at: string }
) {
  const store = new RuntimeTaskLifecycleStore()
  const onOpenTask = vi.fn()
  render(
    <RuntimeTaskLifecycleProvider store={store}>
      <PersonalHomeIssueActivity
        issueId="issue"
        active
        bindings={bindings}
        assignment={assignment}
        onOpenTask={onOpenTask}
      />
    </RuntimeTaskLifecycleProvider>
  )
  return { store, onOpenTask }
}

it('renders the page-provided assignment reason and author without fetching per Issue', async () => {
  await i18n.changeLanguage('en')
  mount([], {
    body: 'Please verify the acceptance criteria',
    created_by_user_name: 'Alice',
    created_at: '2026-11-12',
  })
  expect(screen.getByText('Please verify the acceptance criteria')).toBeInTheDocument()
  expect(screen.getByText('Assignment comment · Alice')).toBeInTheDocument()
})

it('does not fabricate an assignment reason when the batched response has none', () => {
  mount()
  expect(screen.getByTestId('personal-home-assignment-issue')).toBeEmptyDOMElement()
})

it('opens one real task directly and updates its running state from the shared runtime store', async () => {
  await i18n.changeLanguage('en')
  const { onOpenTask, store } = mount([binding])
  expect(screen.getByTestId('personal-home-task-issue-binding')).toHaveTextContent('Implementation')
  expect(screen.getByTestId('personal-home-task-issue-binding')).not.toHaveTextContent(
    'Status unavailable'
  )
  act(() => store.executorStarted(binding))
  expect(screen.getByTestId('personal-home-task-issue-binding')).toHaveTextContent('Running')
  fireEvent.click(screen.getByTestId('personal-home-task-issue-binding'))
  expect(onOpenTask).toHaveBeenCalledExactlyOnceWith(binding)
})

it('summarizes multiple tasks in one row and opens the chosen binding from the picker', () => {
  const second = { ...binding, id: 'second', taskId: 'second', taskTitle: 'Verification' }
  const third = { ...binding, id: 'third', taskId: 'third', taskTitle: 'Review' }
  const { onOpenTask } = mount([binding, second, third])
  expect(screen.queryByTestId('personal-home-task-issue-binding')).not.toBeInTheDocument()
  const summary = screen.getByTestId('personal-home-tasks-summary-issue')
  expect(summary).toHaveTextContent('Implementation、Verification')
  fireEvent.click(summary)
  fireEvent.click(screen.getByTestId('personal-home-task-issue-second'))
  expect(onOpenTask).toHaveBeenCalledExactlyOnceWith(second)
  expect(screen.queryByTestId('personal-home-tasks-picker-issue')).not.toBeInTheDocument()
})

it('uses the same live state for a stored App address and its Runtime device alias', () => {
  const { store } = mount([binding])
  act(() => {
    store.syncDevices([
      {
        id: 65,
        device_id: 'runtime',
        name: 'Local Executor',
        status: 'online',
        is_default: true,
        device_type: 'app',
        bind_shell: 'codex',
        socket_device_id: binding.deviceId,
        runtime_routes: [
          {
            kind: 'local-ipc',
            device_id: binding.deviceId,
            runtime_device_id: 'runtime',
            status: 'online',
          },
        ],
      },
    ])
    store.executorStarted({ ...binding, deviceId: 'runtime' })
  })
  expect(screen.getByTestId('personal-home-task-issue-binding')).toHaveTextContent('Running')
})
