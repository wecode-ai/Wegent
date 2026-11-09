// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { createRuntimeTaskCommandsApi } from './runtimeTaskCommands'
import { createStandInExecutorApi } from './standIn'

it('uses generic task command routes with the reviewed fingerprint and exact native binding', async () => {
  const receipt = { state: 'recovery_required', native: [4, 'thread', 'turn'] }
  const request = vi.fn().mockResolvedValue(receipt)
  const api = createRuntimeTaskCommandsApi(request)
  const target = { taskId: 'task', commandId: 'command', userId: 7 }
  expect(await api.get('owner-device', target)).toBe(receipt)
  expect(request).toHaveBeenLastCalledWith('runtime.tasks.commands.get', target, 'owner-device')
  const resolution = {
    ...target,
    expectedFingerprint: 'reviewed-fingerprint',
    expectedNative: [4, 'thread', 'turn'] as [number, string, string],
    decision: 'abandon' as const,
    requestId: 'stable-resolution-id',
  }
  await api.resolve('owner-device', resolution)
  await api.resolve('owner-device', resolution)
  expect(request.mock.calls.slice(1)).toEqual([
    ['runtime.tasks.commands.resolve', resolution, 'owner-device'],
    ['runtime.tasks.commands.resolve', resolution, 'owner-device'],
  ])
})

it('composes the same generic command client through the existing Executor request transport', async () => {
  const request = vi.fn().mockResolvedValue({ state: 'recovery_required' })
  const api = createStandInExecutorApi(request)
  await api.taskCommands.get('selected-device', {
    userId: 7,
    taskId: 'original-task',
    commandId: 'original-command',
  })
  expect(request).toHaveBeenCalledExactlyOnceWith(
    'runtime.tasks.commands.get',
    { userId: 7, taskId: 'original-task', commandId: 'original-command' },
    'selected-device'
  )
})
