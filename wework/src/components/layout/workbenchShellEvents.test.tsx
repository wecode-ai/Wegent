import { render } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  requestOpenCloudDeviceSettings,
  requestProjectCreateMode,
  requestProjectWorkspaceBinding,
  useWorkbenchShellEventHandlers,
} from './workbenchShellEvents'

test('only the active mounted workbench handles shell requests after switching tabs', () => {
  const task = {
    onCreateProjectMode: vi.fn(),
    onBindProjectWorkspace: vi.fn(),
    onOpenCloudDeviceSettings: vi.fn(),
  }
  const board = {
    onCreateProjectMode: vi.fn(),
    onBindProjectWorkspace: vi.fn(),
    onOpenCloudDeviceSettings: vi.fn(),
  }
  function Workbenches({ taskActive }: { taskActive: boolean }) {
    useWorkbenchShellEventHandlers({ ...task, enabled: taskActive })
    useWorkbenchShellEventHandlers({ ...board, enabled: !taskActive })
    return null
  }
  const { rerender, unmount } = render(<Workbenches taskActive />)
  const requestActions = () => {
    requestProjectCreateMode('existing')
    requestProjectWorkspaceBinding(42)
    requestOpenCloudDeviceSettings()
  }
  requestActions()
  expect(task.onCreateProjectMode).toHaveBeenCalledWith('existing')
  expect(task.onBindProjectWorkspace).toHaveBeenCalledWith(42)
  for (const callback of Object.values(task)) expect(callback).toHaveBeenCalledTimes(1)
  for (const callback of Object.values(board)) expect(callback).not.toHaveBeenCalled()

  rerender(<Workbenches taskActive={false} />)
  requestActions()
  for (const callback of Object.values(task)) expect(callback).toHaveBeenCalledTimes(1)
  for (const callback of Object.values(board)) expect(callback).toHaveBeenCalledTimes(1)

  rerender(<Workbenches taskActive />)
  requestActions()
  for (const callback of Object.values(task)) expect(callback).toHaveBeenCalledTimes(2)
  for (const callback of Object.values(board)) expect(callback).toHaveBeenCalledTimes(1)
  unmount()
  requestActions()
  for (const callback of Object.values(task)) expect(callback).toHaveBeenCalledTimes(2)
  for (const callback of Object.values(board)) expect(callback).toHaveBeenCalledTimes(1)
})
