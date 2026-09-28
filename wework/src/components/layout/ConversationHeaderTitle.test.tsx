import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { ConversationHeaderTitle } from './ConversationHeaderTitle'
import '@/i18n'

const actions = vi.hoisted(() => ({
  renameRuntimeTask: vi.fn(),
  setRuntimeProjectPinned: vi.fn(),
  updateLocalRuntimeProject: vi.fn(),
  openLocalWorkspace: vi.fn(),
}))
vi.mock('@/lib/local-terminal', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/local-terminal')>()),
  isLocalTerminalAvailable: () => true,
  openLocalWorkspace: actions.openLocalWorkspace,
}))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    ...actions,
    projectChat: { models: [] },
    state: { devices: [{ device_id: 'local-device', device_type: 'local', status: 'online' }] },
  }),
}))

const address = { deviceId: 'remote-device', taskId: 'task-1', workspacePath: '/workspace/app' }
const project = { key: 'app', sidebarStateKey: 'remote-app', name: 'App', pinned: false }
const projectWork = {
  project,
  deviceWorkspaces: [
    {
      deviceId: address.deviceId,
      available: true,
      workspacePath: address.workspacePath,
      tasks: [],
    },
  ],
}
const props = { address, projectWork, title: 'Full task title', displayTitle: 'Full task…' }

beforeEach(() => {
  vi.resetAllMocks()
  actions.renameRuntimeTask.mockResolvedValue(undefined)
  actions.setRuntimeProjectPinned.mockResolvedValue(undefined)
  actions.updateLocalRuntimeProject.mockResolvedValue(undefined)
  actions.openLocalWorkspace.mockResolvedValue(undefined)
})

test('shows the project task count and all configured roots, and opens the existing editor', async () => {
  const user = userEvent.setup()
  const roots = [
    { kind: 'local', path: '/Users/tester/workspace/cloudbase' },
    { kind: 'local', path: '/Users/tester/projects/recruiting-2026-08' },
  ]
  render(
    <ConversationHeaderTitle
      {...props}
      projectWork={{
        ...projectWork,
        totalTasks: 7,
        project: { ...project, stateDeviceId: 'local-device', source: 'local_project', roots },
      }}
    />
  )
  const trigger = screen.getByTestId('conversation-project-button')
  await user.click(trigger)
  expect(screen.getByTestId('conversation-project-task-count')).toHaveTextContent('7')
  expect(screen.getAllByTestId('conversation-project-root').map(row => row.textContent)).toEqual([
    '~/workspace/cloudbase',
    '~/projects/recruiting-2026-08',
  ])
  expect(screen.getByTestId('conversation-project-popover')).not.toHaveTextContent(
    address.workspacePath
  )
  for (const [index, root] of roots.entries()) {
    await user.click(screen.getAllByTestId('conversation-project-root')[index])
    expect(actions.openLocalWorkspace).toHaveBeenLastCalledWith({
      opener: 'file-manager',
      path: root.path,
    })
    await waitFor(() =>
      expect(screen.queryByTestId('conversation-project-popover')).not.toBeInTheDocument()
    )
    await user.click(trigger)
  }
  await user.click(screen.getByTestId('conversation-project-edit'))
  expect(screen.queryByTestId('conversation-project-popover')).not.toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(screen.queryByTestId('local-project-edit-dialog')).not.toBeInTheDocument()
  expect(trigger).not.toHaveFocus()
  await user.keyboard('{Enter}')
  expect(screen.queryByTestId('conversation-project-popover')).not.toBeInTheDocument()
  await user.click(trigger)
  await user.click(screen.getByTestId('conversation-project-edit'))
  const input = screen.getByTestId('local-project-name-input')
  expect(input).toHaveValue('App')
  expect(input).toHaveFocus()
  await user.clear(input)
  await user.type(input, 'Updated project{Enter}')
  expect(actions.updateLocalRuntimeProject).toHaveBeenCalledWith(
    expect.objectContaining({
      deviceId: 'local-device',
      projectKey: 'app',
      name: 'Updated project',
      roots: roots.map(root => root.path),
    })
  )
  await waitFor(() =>
    expect(screen.queryByTestId('local-project-edit-dialog')).not.toBeInTheDocument()
  )
  expect(trigger).not.toHaveFocus()
})

test('shows only the workspace for a standalone task', async () => {
  render(<ConversationHeaderTitle {...props} projectWork={undefined} />)
  await userEvent.click(screen.getByTestId('conversation-project-button'))
  expect(screen.getByTestId('conversation-project-root')).toHaveTextContent(address.workspacePath)
  expect(screen.queryByTestId('conversation-project-task-count')).not.toBeInTheDocument()
  expect(screen.queryByTestId('conversation-project-edit')).not.toBeInTheDocument()
  expect(screen.getByTestId('conversation-project-root')).toBeDisabled()
  await userEvent.click(screen.getByTestId('conversation-project-root'))
  expect(actions.openLocalWorkspace).not.toHaveBeenCalled()
})

test('retains the popover on folder-open failure and supports keyboard retry', async () => {
  actions.openLocalWorkspace.mockRejectedValueOnce(new Error('Folder does not exist'))
  render(
    <ConversationHeaderTitle
      {...props}
      projectWork={undefined}
      address={{ ...address, deviceId: 'local-device' }}
    />
  )
  const user = userEvent.setup()
  await user.click(screen.getByTestId('conversation-project-button'))
  const root = screen.getByTestId('conversation-project-root')
  await user.click(root)
  expect(await screen.findByRole('alert')).toHaveTextContent('Folder does not exist')
  root.focus()
  await user.keyboard('{Enter}')
  await waitFor(() =>
    expect(screen.queryByTestId('conversation-project-popover')).not.toBeInTheDocument()
  )
  expect(actions.openLocalWorkspace).toHaveBeenCalledTimes(2)
})

test('edits the complete title, cancels with Escape, and saves with Enter', async () => {
  const user = userEvent.setup()
  render(<ConversationHeaderTitle {...props} />)
  const trigger = screen.getByTestId('conversation-rename-button')
  await user.click(trigger)
  const input = screen.getByTestId('conversation-rename-input')
  expect(input).toHaveValue(props.title)
  expect(input).toHaveFocus()
  await user.type(input, 'Discard{Escape}')
  expect(actions.renameRuntimeTask).not.toHaveBeenCalled()
  expect(trigger).not.toHaveFocus()
  await user.click(trigger)
  await user.clear(screen.getByTestId('conversation-rename-input'))
  await user.type(screen.getByTestId('conversation-rename-input'), '  New title  {Enter}')
  expect(actions.renameRuntimeTask).toHaveBeenCalledWith(address, 'New title')
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(trigger).not.toHaveFocus()
})

test('restores title focus only when renaming was opened with the keyboard', async () => {
  const user = userEvent.setup()
  render(<ConversationHeaderTitle {...props} />)
  const trigger = screen.getByTestId('conversation-rename-button')
  trigger.focus()
  await user.keyboard('{Enter}')
  expect(screen.getByTestId('conversation-rename-input')).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(trigger).toHaveFocus()

  await user.click(trigger)
  await user.keyboard('{Escape}')
  expect(trigger).not.toHaveFocus()
  await user.keyboard('{Enter}')
  expect(screen.queryByTestId('conversation-rename-input')).not.toBeInTheDocument()
})

test('retains the title draft after a rejected save', async () => {
  actions.renameRuntimeTask.mockRejectedValueOnce(new Error('Device disconnected'))
  const user = userEvent.setup()
  render(<ConversationHeaderTitle {...props} />)
  await user.click(screen.getByTestId('conversation-rename-button'))
  const input = screen.getByTestId('conversation-rename-input')
  await user.clear(input)
  await user.type(input, 'Retry title{Enter}')
  expect(await screen.findByText('Device disconnected')).toBeInTheDocument()
  expect(input).toHaveValue('Retry title')
  await user.click(screen.getByTestId('conversation-rename-confirm'))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
})

test('expands project details, pins on the sidebar owner, and dismisses with Escape or outside click', async () => {
  const user = userEvent.setup()
  render(<ConversationHeaderTitle {...props} />)
  const trigger = screen.getByTestId('conversation-project-button')
  await user.click(trigger)
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByTestId('conversation-project-popover')).toHaveTextContent('/workspace/app')
  await user.click(screen.getByTestId('conversation-project-pin'))
  expect(actions.setRuntimeProjectPinned).toHaveBeenCalledWith({
    deviceId: 'local-device',
    projectKey: 'remote-app',
    pinned: true,
  })
  fireEvent.keyDown(document.activeElement!, { key: 'Escape', isComposing: true })
  expect(screen.getByTestId('conversation-project-popover')).toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(screen.queryByTestId('conversation-project-popover')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
  await user.click(trigger)
  await user.click(document.body)
  expect(screen.queryByTestId('conversation-project-popover')).not.toBeInTheDocument()
})
