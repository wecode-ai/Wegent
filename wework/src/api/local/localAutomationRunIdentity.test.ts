import { beforeEach, expect, test, vi } from 'vitest'
import type { LocalExecutorEvent } from '@/desktop/localExecutor'
import { createLocalAppServices, resetLocalRuntimeChatStreamsForTests } from './localServices'

beforeEach(() => {
  localStorage.clear()
  resetLocalRuntimeChatStreamsForTests()
})

test('local arrangement run addresses receive canonical device terminal events without accepting other devices', async () => {
  let listener!: (event: LocalExecutorEvent) => void
  const run = { id: 'run', taskId: 'memory-review-task', status: 'running' }
  const request = vi.fn().mockImplementation(async (method: string) => {
    if (method === 'runtime.automation_runs.list') return { items: [run] }
    if (method === 'runtime.automations.run_now') return { run }
    throw new Error(`Unexpected request: ${method}`)
  })
  const services = createLocalAppServices({
    request,
    available: vi.fn().mockResolvedValue({ running: true, ready: true, deviceId: 'actual-device' }),
    subscribe: vi.fn().mockImplementation(async handler => {
      listener = handler
      return vi.fn()
    }),
  })
  const listed = await services.automationApi!.listAutomationRuns('memory-review')
  const started = await services.automationApi!.runAutomationNow('memory-review')
  expect(listed.items[0].deviceId).toBe('actual-device')
  expect(started.run?.deviceId).toBe('actual-device')
  const onChatDone = vi.fn()
  const cleanup = services.chatStream.subscribe({
    scope: { taskId: run.taskId, deviceId: listed.items[0].deviceId },
    onChatDone,
  })
  await Promise.resolve()
  for (const deviceId of ['other-device', 'actual-device']) {
    listener({
      event: 'response.completed',
      payload: { taskId: run.taskId, subtaskId: 'turn', deviceId, data: { value: 'Finished' } },
    })
    expect(onChatDone).toHaveBeenCalledTimes(deviceId === 'actual-device' ? 1 : 0)
  }
  cleanup()
})
