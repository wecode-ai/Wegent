import { createNativeInteractionReplies } from './nativeInteractionReplies'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import type { RuntimeInteraction } from './runtimeInteractions'

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: vi.fn(),
  subscribeDesktopHostEvents: () => () => {},
}))
vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => true,
  getDesktopWindowLabel: () => 'main',
}))
vi.mock('./standInNotificationStorage', () => ({
  createStandInRecordStore: () => ({ getSnapshot: () => ({}), write: vi.fn() }),
}))

function owner() {
  return {
    active: () => true,
    enabled: () => true,
    items: () => [{ id: 'interaction', cached: false }] as RuntimeInteraction[],
    isHandled: () => false,
    isBusy: () => false,
    respond: vi.fn().mockResolvedValue(true),
    setDraft: vi.fn(),
    retainDraft: vi.fn(),
    retainedReply: () => undefined,
  }
}
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

test('retries a failed inbox and acknowledgement without sending an accepted reply twice', async () => {
  vi.useFakeTimers()
  let reads = 0,
    acknowledgements = 0
  vi.mocked(invokeDesktopHost).mockImplementation(async capability => {
    if (capability === 'notification.pendingReplies') {
      if (++reads === 1) throw new Error('state unavailable')
      return [{ id: 'reply', interactionId: 'interaction', text: 'answer' }] as never
    }
    if (++acknowledgements === 1) throw new Error('ack unavailable')
    return undefined as never
  })
  const input = owner(),
    replies = createNativeInteractionReplies('account', input)
  replies.synchronize()
  await vi.advanceTimersByTimeAsync(2_000)
  expect(reads).toBe(3)
  expect(input.respond).toHaveBeenCalledOnce()
  expect(acknowledgements).toBe(2)
  replies.disconnect()
  expect(vi.getTimerCount()).toBe(0)
})

test('a busy-state change drains a retained reply even when the items did not change', async () => {
  vi.useFakeTimers()
  vi.mocked(invokeDesktopHost).mockImplementation(async capability =>
    capability === 'notification.pendingReplies'
      ? ([{ id: 'reply', interactionId: 'interaction', text: 'answer' }] as never)
      : (undefined as never)
  )
  let busy = true
  const input = { ...owner(), isBusy: () => busy },
    replies = createNativeInteractionReplies('account', input)
  replies.synchronize()
  await vi.advanceTimersByTimeAsync(0)
  expect(input.respond).not.toHaveBeenCalled()
  busy = false
  replies.synchronize()
  await vi.advanceTimersByTimeAsync(0)
  expect(input.respond).toHaveBeenCalledOnce()
  replies.disconnect()
})
