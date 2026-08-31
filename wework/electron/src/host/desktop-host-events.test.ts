import { describe, expect, test } from 'vitest'
import { DesktopHostEventBroker } from './desktop-host-events.js'

describe('DesktopHostEventBroker', () => {
  test('returns events published after the requested sequence', () => {
    const broker = new DesktopHostEventBroker()
    broker.publish('tray.action', { type: 'open-settings' })

    expect(broker.read(0)).toEqual({
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

  test('reports when the requested sequence fell out of retained history', () => {
    const broker = new DesktopHostEventBroker()
    for (let index = 0; index < 1026; index += 1) {
      broker.publish('browser.event', { index })
    }

    const batch = broker.read(1)
    expect(batch.historyLost).toBe(true)
    expect(batch.latestSequence).toBe(1026)
    expect(batch.events).toHaveLength(1024)
    expect(batch.events[0]?.sequence).toBe(3)
  })

  test('reports history loss for an initial cursor', () => {
    const broker = new DesktopHostEventBroker()
    for (let index = 0; index < 1025; index += 1) {
      broker.publish('browser.event', { index })
    }

    expect(broker.read(0).historyLost).toBe(true)
  })
})
