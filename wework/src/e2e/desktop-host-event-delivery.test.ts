import { afterEach, expect, test, vi } from 'vitest'
import { invokeDesktopHost, readDesktopHostEventCursor } from '@/api/dsh/desktopHost'
import { waitForDesktopHostEventDelivery } from './desktop-host-event-delivery'

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: vi.fn(),
  readDesktopHostEventCursor: vi.fn(),
}))

afterEach(() => vi.useRealTimers())

test('waits for renderer delivery after the host publishes an event', async () => {
  vi.useFakeTimers()
  vi.mocked(invokeDesktopHost).mockResolvedValue({ latestSequence: 7 })
  vi.mocked(readDesktopHostEventCursor).mockReturnValue(6)
  let completed = false
  const delivery = waitForDesktopHostEventDelivery(1000).then(value => {
    completed = true
    return value
  })
  await vi.advanceTimersByTimeAsync(50)
  expect(completed).toBe(false)
  vi.mocked(readDesktopHostEventCursor).mockReturnValue(7)
  await vi.advanceTimersByTimeAsync(25)
  await expect(delivery).resolves.toBe('7')
})
