import { describe, expect, test, vi } from 'vitest'
import { createTelemetryDispatcher } from './dispatcher'
import type { WeworkTelemetryFact } from './facts'

const flushPromises = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function smartAppFact(name: WeworkTelemetryFact['name']): WeworkTelemetryFact {
  return {
    name,
    occurredAt: '2026-09-09T00:00:00.000Z',
    properties: name.endsWith('_failed')
      ? { domain: 'smart_app', failure_stage: 'install' }
      : { domain: 'smart_app' },
    context: {
      smartApp: {
        key: 'research',
        name: 'Research',
        source: 'market',
        version: '1.0.0',
      },
      user: {
        email: 'zhongyang@example.invalid',
        id: 7,
        userName: 'zhongyang',
      },
    },
  } as WeworkTelemetryFact
}

describe('telemetry dispatcher', () => {
  test('strips private plugin properties and internal identity from public observations', () => {
    const accept = vi.fn()
    const dispatcher = createTelemetryDispatcher({
      distribution: 'public',
      internalSinks: () => [],
      publicSink: { id: 'public', accept },
    })
    dispatcher.publish({
      name: 'plugin_installed',
      occurredAt: '2026-09-10',
      properties: { source: 'local', path: '/private/plugin', plugin_name: 'private' },
      context: { user: { id: 7, email: 'private@example.invalid', userName: 'private' } },
    } as WeworkTelemetryFact)
    expect(accept).toHaveBeenCalledWith({
      name: 'plugin_installed',
      properties: { source: 'local' },
    })
  })

  test('projects public fields and does not forward internal context', async () => {
    const publicSink = vi.fn()
    const internalSink = vi.fn()
    const dispatcher = createTelemetryDispatcher({
      distribution: 'public',
      internalSinks: () => [
        { accept: internalSink, id: 'internal', protocol: 'telemetry-sink/v1' },
      ],
      publicSink: { accept: publicSink, id: 'public' },
    })

    dispatcher.publish(smartAppFact('smart_app_opened'))
    await flushPromises()

    expect(publicSink).toHaveBeenCalledWith({
      name: 'smart_app_opened',
      properties: { domain: 'smart_app' },
    })
    expect(internalSink).not.toHaveBeenCalled()
  })

  test('isolates an internal sink failure from other sinks', async () => {
    const recordingSink = vi.fn()
    const dispatcher = createTelemetryDispatcher({
      distribution: 'internal',
      internalSinks: () => [
        {
          accept: () => Promise.reject(new Error('sink unavailable')),
          id: 'rejecting',
          protocol: 'telemetry-sink/v1',
        },
        { accept: recordingSink, id: 'recording', protocol: 'telemetry-sink/v1' },
      ],
      publicSink: null,
    })

    expect(() => dispatcher.publish(smartAppFact('smart_app_owned_opened'))).not.toThrow()
    await flushPromises()

    expect(recordingSink).toHaveBeenCalledOnce()
    expect(recordingSink).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          user: expect.objectContaining({ userName: 'zhongyang' }),
        }),
        name: 'smart_app_owned_opened',
      })
    )
  })

  test('buffers internal facts until a sink registers and assigns each sink a unique envelope id', async () => {
    const firstSink = vi.fn()
    const secondSink = vi.fn()
    let sinks = []
    const dispatcher = createTelemetryDispatcher({
      distribution: 'internal',
      internalSinks: () => sinks,
      publicSink: null,
    })

    dispatcher.publish(smartAppFact('smart_app_install_succeeded'))
    expect(firstSink).not.toHaveBeenCalled()

    sinks = [
      { accept: firstSink, id: 'first', protocol: 'telemetry-sink/v1' },
      { accept: secondSink, id: 'second', protocol: 'telemetry-sink/v1' },
    ]
    dispatcher.flushInternalSinks()
    await flushPromises()

    expect(firstSink).toHaveBeenCalledOnce()
    expect(secondSink).toHaveBeenCalledOnce()
    expect(firstSink.mock.calls[0]?.[0].eventId).not.toEqual(secondSink.mock.calls[0]?.[0].eventId)
  })
})
