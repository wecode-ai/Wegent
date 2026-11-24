import { act, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { StandInTaskPermissions } from '@/api/personalStandIn'
import type { RuntimeTaskSummary } from '@/types/api'
import { useRuntimeTaskPermissions } from './useRuntimeTaskPermissions'
import type { WorkbenchServices } from './workbenchServices'

const address = { deviceId: 'device', taskId: 'task' }

const taskSnapshot = (
  snapshotRevision: string,
  permissionMode: StandInTaskPermissions['permissionMode']
): RuntimeTaskSummary => ({
  taskId: address.taskId,
  snapshotRevision,
  title: 'Stand-in task',
  workspacePath: '',
  runtime: 'codex',
  runtimeHandle: {
    origin: { type: 'stand_in_task', userId: 7 },
    taskPermissions: { permissionMode },
  },
})

test('keeps the newest permission when earlier refreshes arrive after a save', async () => {
  const initial = taskSnapshot('9007199254740993000', 'read-only')
  const firstSave = taskSnapshot('9007199254740993001', 'workspace-write')
  const secondSave = taskSnapshot('9007199254740993002', 'read-only')
  const laterChange = taskSnapshot('9007199254740993003', 'full-access')
  const receipt = ({ snapshotRevision, runtimeHandle }: RuntimeTaskSummary) => ({
    snapshotRevision,
    taskPermissions: runtimeHandle!.taskPermissions,
  })
  const api = {
    setTaskPermissions: vi
      .fn()
      .mockResolvedValueOnce(receipt(firstSave))
      .mockResolvedValueOnce(receipt(secondSave)),
  } as WorkbenchServices['standInApi']
  const refresh = vi.fn().mockResolvedValue(undefined)

  const { result, rerender } = renderHook(
    (task: RuntimeTaskSummary) => useRuntimeTaskPermissions(address, task, 7, api, refresh),
    { initialProps: initial }
  )
  expect(result.current.permissionControls?.value).toBe('read-only')

  await act(async () => result.current.permissionControls?.onChange('workspace-write'))
  expect(result.current.permissionControls?.value).toBe('workspace-write')
  await act(async () => result.current.permissionControls?.onChange('read-only'))
  expect(result.current.permissionControls?.value).toBe('read-only')

  rerender(firstSave)
  expect(result.current.permissionControls?.value).toBe('read-only')
  rerender(secondSave)
  expect(result.current.permissionControls?.value).toBe('read-only')
  rerender(laterChange)
  expect(result.current.permissionControls?.value).toBe('full-access')
  rerender(secondSave)
  expect(result.current.permissionControls?.value).toBe('full-access')
})

test('retains a failed permission save error through a newer task summary', async () => {
  const initial = taskSnapshot('1', 'read-only')
  const firstSave = taskSnapshot('2', 'workspace-write')
  const refreshed = taskSnapshot('3', 'workspace-write')
  const save = Promise.withResolvers<never>()
  const api = {
    setTaskPermissions: vi
      .fn()
      .mockResolvedValueOnce({
        snapshotRevision: firstSave.snapshotRevision,
        taskPermissions: firstSave.runtimeHandle!.taskPermissions,
      })
      .mockReturnValueOnce(save.promise),
  } as WorkbenchServices['standInApi']
  const refresh = vi.fn().mockResolvedValue(undefined)
  const { result, rerender } = renderHook(
    (task: RuntimeTaskSummary) => useRuntimeTaskPermissions(address, task, 7, api, refresh),
    { initialProps: initial }
  )

  await act(async () => result.current.permissionControls?.onChange('workspace-write'))
  act(() => result.current.permissionControls?.onChange('read-only'))
  expect(result.current.permissionControls?.disabled).toBe(true)
  rerender(firstSave)
  await act(async () => save.reject(new Error('device_offline')))

  const error = result.current.permissionError?.message
  expect(error).toBeTruthy()
  rerender(refreshed)
  expect(result.current.permissionControls?.value).toBe('workspace-write')
  expect(result.current.permissionError?.message).toBe(error)
  act(() => result.current.permissionError?.dismiss())
  expect(result.current.permissionError).toBeUndefined()
})
