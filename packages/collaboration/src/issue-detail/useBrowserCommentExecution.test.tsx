// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import { useBrowserCommentExecution } from './useBrowserCommentExecution'

let root: Root
let current: ReturnType<typeof useBrowserCommentExecution>
const app = {
  device_id: 'app-device',
  device_type: 'app',
  status: 'online',
  is_default: true,
  executor_version: '1.9.0',
}
const local = { ...app, device_id: 'local-device', device_type: 'local', is_default: false }

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  root = createRoot(document.createElement('div'))
})
afterEach(() => act(() => root.unmount()))

async function render(devices: (typeof app)[]) {
  const runtime = {
    listDevices: vi.fn().mockResolvedValue(devices),
    listModels: vi.fn().mockResolvedValue([]),
    work: {
      listRuntimeWork: vi.fn().mockResolvedValue({
        projects: [
          {
            project: { id: 1, key: 'repo', name: 'Repository', stateDeviceId: app.device_id },
            deviceWorkspaces: [
              {
                id: 1,
                deviceId: app.device_id,
                workspacePath: '/repo',
                available: true,
                deviceStatus: 'online',
              },
            ],
            tasks: [],
          },
        ],
        chats: [],
      }),
    },
  } as unknown as SharedWorkspaceRuntimeApi
  function Harness() {
    current = useBrowserCommentExecution(runtime)
    return null
  }
  await act(async () => root.render(<Harness />))
  return runtime
}

it('ignores an APP default device and loads models from the eligible standalone executor', async () => {
  const runtime = await render([app, local])
  expect(current.target?.deviceId).toBe(local.device_id)
  expect(current.standaloneTarget?.deviceId).toBe(local.device_id)
  expect(runtime.listModels).toHaveBeenCalledExactlyOnceWith(local.device_id)
  expect(current.error).toBeNull()
})

it('does not request APP models on opening or retrying an Issue with no controllable executor', async () => {
  const runtime = await render([app])
  expect(current.target).toBeNull()
  expect(current.standaloneTarget).toBeNull()
  expect(current.loading).toBe(false)
  expect(current.catalogCurrent).toBe(true)
  expect(current.error).toBeNull()
  expect(runtime.listModels).not.toHaveBeenCalled()
  await act(async () => current.retry())
  expect(runtime.listModels).not.toHaveBeenCalled()
})

it('marks APP workspaces unavailable and rejects selecting one even while it is online', async () => {
  const runtime = await render([app, local])
  const workspace = current.work!.projects[0].deviceWorkspaces[0]
  expect(workspace.available).toBe(false)
  await act(async () => current.selectProject(current.projects[0].id, workspace))
  expect(current.target).toBeNull()
  expect(runtime.listModels).toHaveBeenCalledExactlyOnceWith(local.device_id)
})
