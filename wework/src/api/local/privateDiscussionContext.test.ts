import { beforeEach, expect, test, vi } from 'vitest'
import { createLocalAppServices } from './localServices'
import { clearLocalModelConfigs } from '@/features/model-settings/localModelSettings'

beforeEach(() => {
  localStorage.clear()
  clearLocalModelConfigs()
})

test('keeps private discussion context on native send, interrupt and guidance without rebinding', async () => {
  const request = vi.fn().mockResolvedValue({ accepted: true })
  const services = createLocalAppServices({
    ensure: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'device-1' }),
    request,
    subscribe: vi.fn(),
  })
  const origin = {
    type: 'issue_dispatch' as const,
    initiatedBy: 'stand_in',
    userId: 7,
    projectStore: 'local',
    cloudProjectId: 'project',
    loopItemId: 'issue',
  }
  const address = {
    deviceId: 'device-1',
    taskId: 'original-task',
    threadId: 'original-thread',
    runtime: 'claude_code',
    workspacePath: '/tmp/project',
    runtimeHandle: { origin },
  }
  const input = {
    address,
    message: 'Private question',
    conversationContext: 'private_discussion' as const,
  }
  const api = services.runtimeWorkApi!
  await api.sendRuntimeMessage(input)
  await api.interruptAndSendRuntimeMessage(input)
  await api.guideRuntimeTask(input)
  for (const method of [
    'runtime.tasks.send',
    'runtime.tasks.interrupt_and_send',
    'runtime.tasks.guidance',
  ]) {
    const payload = request.mock.calls.find(([name]) => name === method)?.[1]
    expect(payload).toMatchObject({
      taskId: 'original-task',
      address: { deviceId: 'device-1', taskId: 'original-task', threadId: 'original-thread' },
      conversationContext: 'private_discussion',
    })
    if (method !== 'runtime.tasks.guidance') {
      expect(payload.executionRequest.origin).toEqual(origin)
      expect(payload.executionRequest.ephemeral).toBe(false)
    }
  }
  expect(request.mock.calls.some(([method]) => method === 'runtime.tasks.create')).toBe(false)
  request.mockClear()
  await api.sendRuntimeMessage({ address, message: 'Ordinary execution' })
  const payload = request.mock.calls.find(([method]) => method === 'runtime.tasks.send')?.[1]
  expect(payload).not.toHaveProperty('conversationContext')
  expect(payload.executionRequest.origin).toEqual(origin)
})
