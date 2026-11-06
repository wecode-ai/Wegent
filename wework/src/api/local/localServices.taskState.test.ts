import { expect, test, vi } from 'vitest'
import { createRuntimeWorkApiFromIpc } from './localServices'

test('reads authoritative task state without loading history or preparing a model', async () => {
  const task = {
    taskId: 'task',
    title: 'Completed task',
    runtime: 'codex',
    workspacePath: '/workspace',
    running: false,
    status: 'done',
    executionState: { revision: '42', phase: 'idle', turnId: null, latestTurnId: 'turn' },
  }
  const request = vi.fn().mockResolvedValue({ success: true, task })
  const api = createRuntimeWorkApiFromIpc(request, async () => 'device')
  const controller = new AbortController()
  const address = { deviceId: 'device', taskId: 'task', workspacePath: '/workspace' }
  await expect(api.getRuntimeTask(address, { signal: controller.signal })).resolves.toMatchObject(
    task
  )
  expect(request).toHaveBeenCalledExactlyOnceWith('runtime.tasks.get', address, 'device', {
    signal: controller.signal,
  })
})

test('does not bypass project authorization with the owner task lookup', async () => {
  const request = vi.fn()
  const api = createRuntimeWorkApiFromIpc(request, async () => 'device')
  await expect(
    api.getRuntimeTask({
      deviceId: 'device',
      taskId: 'task',
      projectSession: { projectId: 'project', issueId: 'issue' },
    })
  ).resolves.toBeNull()
  expect(request).not.toHaveBeenCalled()
})

test('keeps a failed task lookup distinct from a completed execution', async () => {
  const request = vi
    .fn()
    .mockResolvedValue({ success: false, error: 'Task is no longer available' })
  const api = createRuntimeWorkApiFromIpc(request, async () => 'device')
  await expect(api.getRuntimeTask({ deviceId: 'device', taskId: 'missing' })).rejects.toThrow(
    'Task is no longer available'
  )
})
