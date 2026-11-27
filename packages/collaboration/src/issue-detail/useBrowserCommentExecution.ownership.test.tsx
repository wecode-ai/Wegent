// @vitest-environment jsdom
import { act, createRef, useImperativeHandle } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DeviceInfo } from '@wegent/chat-core/execution-project'
import type { UnifiedModel } from '@wegent/chat-core/models'
import type { RuntimeWorkListResponse } from '@wegent/chat-core/runtime-task-api-types'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import { useBrowserCommentExecution } from './useBrowserCommentExecution'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}
const device = (id: string): DeviceInfo => ({
  id: id === 'device-a' ? 1 : 2,
  device_id: id,
  device_type: 'local',
  name: id,
  status: 'online',
  is_default: id === 'device-a',
  executor_version: '1.9.0',
})
function fixture(label = 'Current') {
  const work: RuntimeWorkListResponse = {
    totalTasks: 0,
    chats: [],
    projects: ['device-a', 'device-b'].map((deviceId, index) => ({
      project: { id: index + 1, key: deviceId, name: `${label} ${deviceId}` },
      deviceWorkspaces: [
        {
          id: index + 1,
          deviceId,
          workspacePath: `/work/${deviceId}`,
          available: true,
          deviceStatus: 'online',
          tasks: [],
        },
      ],
    })),
  }
  const listDevices = vi
    .fn<SharedWorkspaceRuntimeApi['listDevices']>()
    .mockResolvedValue([device('device-a'), device('device-b')])
  const listModels = vi
    .fn<SharedWorkspaceRuntimeApi['listModels']>()
    .mockImplementation(async deviceId => [{ name: `${label} ${deviceId}`, type: 'runtime' }])
  const listRuntimeWork = vi
    .fn<SharedWorkspaceRuntimeApi['work']['listRuntimeWork']>()
    .mockResolvedValue(work)
  const runtime = {
    listDevices,
    listModels,
    work: { listRuntimeWork },
  } as unknown as SharedWorkspaceRuntimeApi
  return { runtime, work, listDevices, listModels, listRuntimeWork }
}
let root: Root
const result = createRef<ReturnType<typeof useBrowserCommentExecution>>()
function Harness({ runtime }: { runtime: SharedWorkspaceRuntimeApi }) {
  const execution = useBrowserCommentExecution(runtime)
  useImperativeHandle(result, () => execution, [execution])
  return null
}
const mount = async (runtime: SharedWorkspaceRuntimeApi) => {
  await act(async () => root.render(<Harness runtime={runtime} />))
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  root = createRoot(document.createElement('div'))
})
afterEach(() => act(() => root.unmount()))

function selectSecondProject() {
  result.current!.selectProject(
    result.current!.projects[1].id,
    result.current!.work!.projects[1].deviceWorkspaces[0]
  )
}

test('waits for the execution catalog before reading the selected device models', async () => {
  const f = fixture(),
    pending = deferred<RuntimeWorkListResponse>()
  f.listRuntimeWork.mockReturnValue(pending.promise)
  await mount(f.runtime)
  expect(result.current!.loading).toBe(true)
  expect(result.current!.catalogCurrent).toBe(false)
  expect(result.current!.target).toBeNull()
  expect(f.listModels).not.toHaveBeenCalled()
  await act(async () => pending.resolve(f.work))
  expect(result.current!.catalogCurrent).toBe(true)
  expect(result.current!.modelsReady).toBe(true)
  expect(f.listModels).toHaveBeenCalledExactlyOnceWith('device-a')
})

test('keeps execution readiness independent of slow or failed model discovery', async () => {
  const f = fixture(),
    pending = deferred<UnifiedModel[]>()
  f.listModels.mockReturnValue(pending.promise)
  await mount(f.runtime)
  expect(result.current!.catalogCurrent).toBe(true)
  expect(result.current!.target?.deviceId).toBe('device-a')
  expect(result.current!.modelsReady).toBe(false)
  await act(async () => pending.reject(new Error('Models offline')))
  expect(result.current!.catalogCurrent).toBe(true)
  expect(result.current!.catalogError).toBeNull()
  expect(result.current!.error).toBe('Models offline')
  expect(result.current!.target?.deviceId).toBe('device-a')
})

test('retains valid same-source data when a catalog refresh fails and recovers on explicit retry', async () => {
  const f = fixture()
  await mount(f.runtime)
  const originalProjects = result.current!.projects
  f.listRuntimeWork.mockRejectedValueOnce(new Error('Catalog offline'))
  await act(async () => result.current!.retry())
  expect(result.current!.catalogCurrent).toBe(false)
  expect(result.current!.catalogError).toBe('Catalog offline')
  expect(result.current!.projects).toBe(originalProjects)
  expect(result.current!.target?.deviceId).toBe('device-a')
  await act(async () => result.current!.retry())
  expect(result.current!.catalogCurrent).toBe(true)
  expect(result.current!.catalogError).toBeNull()
  expect(f.listRuntimeWork).toHaveBeenCalledTimes(3)
  expect(f.listModels.mock.calls.map(([deviceId]) => deviceId)).toEqual([
    'device-a',
    'device-a',
    'device-a',
  ])
})

test('keeps visible model metadata during refresh and treats a successful empty result as authoritative', async () => {
  const f = fixture(),
    pending = deferred<UnifiedModel[]>()
  await mount(f.runtime)
  const previous = result.current!.models
  f.listModels.mockReturnValueOnce(pending.promise)
  await act(async () => result.current!.retry())
  expect(result.current!.models).toBe(previous)
  expect(result.current!.modelsReady).toBe(false)
  expect(result.current!.catalogCurrent).toBe(true)
  await act(async () => pending.resolve([]))
  expect(result.current!.models).toEqual([])
  expect(result.current!.modelsReady).toBe(true)
})

test('does not expose old model metadata for a new runtime with the same device ID', async () => {
  const old = fixture('Old'),
    next = fixture('Next'),
    pending = deferred<RuntimeWorkListResponse>()
  await mount(old.runtime)
  expect(result.current!.models[0].name).toContain('Old')
  next.listRuntimeWork.mockReturnValue(pending.promise)
  await mount(next.runtime)
  expect(result.current!.models).toEqual([])
  expect(result.current!.modelsReady).toBe(false)
  expect(result.current!.work).toBeUndefined()
  expect(result.current!.catalogCurrent).toBe(false)
  await act(async () => pending.resolve(next.work))
  expect(result.current!.models[0].name).toContain('Next')
})

test('aborts old catalog ownership and ignores its late response after changing runtimes', async () => {
  const old = fixture('Old'),
    next = fixture('Next'),
    pending = deferred<RuntimeWorkListResponse>()
  old.listRuntimeWork.mockReturnValue(pending.promise)
  await mount(old.runtime)
  const signal = old.listRuntimeWork.mock.calls[0][0]?.signal
  await mount(next.runtime)
  expect(signal?.aborted).toBe(true)
  await act(async () => pending.resolve(old.work))
  expect(result.current!.projects[0].name).toContain('Next')
  expect(old.listModels).not.toHaveBeenCalled()
})

test('refreshes only active model readers and ignores a former device response', async () => {
  const f = fixture(),
    oldModels = deferred<UnifiedModel[]>()
  f.listModels.mockReturnValueOnce(oldModels.promise)
  await mount(f.runtime)
  const retry = result.current!.retry
  await act(async () => selectSecondProject())
  expect(result.current!.target?.deviceId).toBe('device-b')
  expect(result.current!.models[0].name).toContain('device-b')
  expect(result.current!.retry).toBe(retry)
  await act(async () => result.current!.retry())
  expect(f.listModels.mock.calls.map(([deviceId]) => deviceId)).toEqual([
    'device-a',
    'device-b',
    'device-b',
  ])
  await act(async () => oldModels.resolve([{ name: 'Late device A', type: 'runtime' }]))
  expect(result.current!.models[0].name).toContain('device-b')
})

test('resets workspace selection on owner change and ignores a former owner selection callback', async () => {
  const old = fixture('Old'),
    next = fixture('Next')
  await mount(old.runtime)
  await act(async () => selectSecondProject())
  expect(result.current!.target?.deviceId).toBe('device-b')
  const oldSelect = result.current!.selectProject,
    oldProject = result.current!.projects[1].id,
    oldWorkspace = result.current!.workspace!
  await mount(next.runtime)
  expect(result.current!.selection).toBeNull()
  expect(result.current!.target?.deviceId).toBe('device-a')
  await act(async () => oldSelect(oldProject, oldWorkspace))
  expect(result.current!.selection).toBeNull()
  expect(result.current!.target?.deviceId).toBe('device-a')
  expect(next.listModels).toHaveBeenCalledExactlyOnceWith('device-a')
})

test('does not issue new reads through retry callbacks retained after unmount', async () => {
  const f = fixture()
  await mount(f.runtime)
  const retry = result.current!.retry
  await act(async () => root.render(null))
  await act(async () => retry())
  expect(f.listRuntimeWork).toHaveBeenCalledTimes(1)
  expect(f.listDevices).toHaveBeenCalledTimes(1)
  expect(f.listModels).toHaveBeenCalledTimes(1)
})
