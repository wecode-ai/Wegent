import '@/i18n'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { ConversationHeaderTitle } from './ConversationHeaderTitle'

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
    services: {},
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
