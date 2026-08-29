import { describe, expect, test, vi } from 'vitest'
import { DesktopHostEventBroker } from './desktop-host-events.js'

describe('DesktopHostEventBroker', () => {
  test('resolves a pending wait when an event is published', async () => {
    const broker = new DesktopHostEventBroker()
    const pending = broker.wait(0)

    broker.publish('tray.action', { type: 'open-settings' })

    await expect(pending).resolves.toEqual({
      events: [
        {
          sequence: 1,
          type: 'tray.action',
          payload: { type: 'open-settings' },
        },
      ],
      latestSequence: 1,
      historyLost: false,
    })
  })

  test('returns an empty heartbeat batch after the requested timeout', async () => {
    vi.useFakeTimers()
    const broker = new DesktopHostEventBroker()
    const pending = broker.wait(0, 100)

    await vi.advanceTimersByTimeAsync(100)

    await expect(pending).resolves.toEqual({
      events: [],
      latestSequence: 0,
      historyLost: false,
    })
    vi.useRealTimers()
  })
})
