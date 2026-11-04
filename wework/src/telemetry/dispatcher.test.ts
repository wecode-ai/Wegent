import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createTelemetryDispatcher } from './dispatcher'
import type { WeworkTelemetryFact } from './facts'

const flushPromises = () => new Promise<void>(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  vi.unstubAllEnvs()
})

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
    },
  } as WeworkTelemetryFact
}

type SmartAppSinkEnvelope = {
  readonly context?: {
    readonly smartApp?: Readonly<Record<string, unknown>>
  }
}

async function deliverSmartAppFact(
  contextFields: readonly string[],
  delivery: 'immediate' | 'queued',
  smartAppOverrides: Readonly<Record<string, unknown>> = {}
): Promise<ReturnType<typeof vi.fn>> {
  if (contextFields.length > 0) {
    vi.stubEnv('VITE_WEWORK_TELEMETRY_CONTEXT_FIELDS', JSON.stringify(contextFields))
  }
  const internalAccept = vi.fn()
  const sink = { id: 'internal', accept: internalAccept }
  let sinks = delivery === 'immediate' ? [sink] : []
  const dispatcher = createTelemetryDispatcher(vi.fn(), {
    internalSinks: () => sinks,
    isInternalDeliveryEnabled: () => true,
  })

  const fact = smartAppFact('smart_app_opened')
  dispatcher.publish({
    ...fact,
    context: {
      ...fact.context,
      smartApp: { ...fact.context?.smartApp, ...smartAppOverrides },
    },
  } as WeworkTelemetryFact)
  if (delivery === 'queued') {
    sinks = [sink]
    dispatcher.flushInternalSinks()
  }
  await flushPromises()
  return internalAccept
}

function pluginInvocationFact(durationMs: number | undefined): WeworkTelemetryFact {
  return {
    name: 'plugin_invocation_succeeded',
    occurredAt: '2026-09-21',
    properties: {
      capability_type: 'mcp',
      execution_surface: 'task',
      executor_location: 'local',
      plugin_distribution: 'personal',
      plugin_id: 'personal/private-plugin',
    },
    context: {
      pluginInvocation: {
        ...(durationMs === undefined ? {} : { durationMs }),
        marketplace: 'private-marketplace',
        pluginKey: 'private-plugin',
        toolName: 'private_server.search',
        version: '1.0.0',
      },
    },
  } as WeworkTelemetryFact
}

describe('telemetry dispatcher', () => {
  test('keeps stable plugin identity while stripping private plugin details', () => {
    const accept = vi.fn()
    const dispatcher = createTelemetryDispatcher(accept)
    dispatcher.publish({
      name: 'plugin_installed',
      occurredAt: '2026-09-10',
      properties: {
        source: 'local',
        plugin_distribution: 'personal',
        plugin_id: 'personal/private-plugin',
        path: '/private/plugin',
        plugin_name: 'private',
        user_id: 7,
        email: 'private@example.invalid',
      },
    } as WeworkTelemetryFact)
    expect(accept).toHaveBeenCalledWith({
      name: 'plugin_installed',
      properties: {
        source: 'local',
        plugin_distribution: 'personal',
        plugin_id: 'personal/private-plugin',
      },
    })
  })

  test('projects the safe plugin id while keeping invocation context separate from event properties', () => {
    const accept = vi.fn()
    const dispatcher = createTelemetryDispatcher(accept)
    dispatcher.publish({
      name: 'plugin_invocation_succeeded',
      occurredAt: '2026-09-21',
      properties: {
        capability_type: 'mcp',
        execution_surface: 'task',
        executor_location: 'local',
        plugin_distribution: 'personal',
        plugin_id: 'personal/private-plugin',
      },
      context: {
        pluginInvocation: {
          marketplace: 'private-marketplace',
          pluginKey: 'private-plugin',
          toolName: 'private_server.search',
          version: '1.0.0',
        },
      },
    })

    expect(accept).toHaveBeenCalledWith({
      context: {
        pluginInvocation: {
          marketplace: 'private-marketplace',
          pluginKey: 'private-plugin',
          toolName: 'private_server.search',
          version: '1.0.0',
        },
      },
      name: 'plugin_invocation_succeeded',
      properties: {
        capability_type: 'mcp',
        execution_surface: 'task',
        executor_location: 'local',
        plugin_distribution: 'personal',
        plugin_id: 'personal/private-plugin',
      },
    })
  })

  test('isolates synchronous and asynchronous transport failures from business results', async () => {
    for (const accept of [
      () => {
        throw new Error('offline')
      },
      () => Promise.reject(new Error('offline')),
    ]) {
      const dispatcher = createTelemetryDispatcher(accept)
      expect(() => dispatcher.publish(smartAppFact('smart_app_opened'))).not.toThrow()
      await flushPromises()
    }
  })

  test('flushes full telemetry envelopes to sinks that register after startup', async () => {
    vi.stubEnv(
      'VITE_WEWORK_TELEMETRY_CONTEXT_FIELDS',
      '["smart_app_key","smart_app_name","smart_app_version","smart_app_source"]'
    )
    const publicAccept = vi.fn()
    const internalAccept = vi.fn()
    let sinks: Array<{ id: string; accept: (fact: unknown) => void }> = []
    const dispatcher = createTelemetryDispatcher(publicAccept, {
      internalSinks: () => sinks,
      isInternalDeliveryEnabled: () => true,
    })

    dispatcher.publish(smartAppFact('smart_app_opened'))
    expect(publicAccept).toHaveBeenCalledWith({
      name: 'smart_app_opened',
      properties: { domain: 'smart_app' },
      context: expect.any(Object),
    })
    expect(internalAccept).not.toHaveBeenCalled()

    sinks = [{ id: 'delayed', accept: internalAccept }]
    dispatcher.flushInternalSinks()
    await flushPromises()

    expect(internalAccept).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: expect.any(String),
        name: 'smart_app_opened',
        context: expect.objectContaining({ smartApp: expect.any(Object) }),
        occurredAt: '2026-09-09T00:00:00.000Z',
      })
    )
  })

  test('delivers no plugin identity to sinks under the default field policy', async () => {
    const internalAccept = vi.fn()
    const dispatcher = createTelemetryDispatcher(vi.fn(), {
      internalSinks: () => [{ id: 'internal', accept: internalAccept }],
      isInternalDeliveryEnabled: () => true,
    })

    dispatcher.publish(pluginInvocationFact(undefined))
    await flushPromises()

    expect(internalAccept).toHaveBeenCalledWith({
      name: 'plugin_invocation_succeeded',
      properties: {
        capability_type: 'mcp',
        execution_surface: 'task',
        executor_location: 'local',
        plugin_distribution: 'personal',
        plugin_id: 'personal/private-plugin',
      },
      occurredAt: '2026-09-21',
      eventId: expect.any(String),
    })
    const envelope = internalAccept.mock.calls[0][0] as Record<string, unknown>
    expect(envelope).not.toHaveProperty('context')
    expect(JSON.stringify(envelope)).not.toMatch(
      /private-marketplace|private_server\.search|1\.0\.0/
    )
  })

  test('delivers only the context fields selected by the collection policy', async () => {
    vi.stubEnv('VITE_WEWORK_TELEMETRY_CONTEXT_FIELDS', '["plugin_key","tool_duration_ms"]')
    const internalAccept = vi.fn()
    const dispatcher = createTelemetryDispatcher(vi.fn(), {
      internalSinks: () => [{ id: 'internal', accept: internalAccept }],
      isInternalDeliveryEnabled: () => true,
    })

    dispatcher.publish(pluginInvocationFact(42))
    await flushPromises()

    expect(internalAccept).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { pluginInvocation: { pluginKey: 'private-plugin', durationMs: 42 } },
      })
    )
    expect(JSON.stringify(internalAccept.mock.calls[0][0])).not.toMatch(
      /private-marketplace|private_server\.search|1\.0\.0/
    )
  })

  test('applies the field policy when queued facts flush after registration', async () => {
    vi.stubEnv('VITE_WEWORK_TELEMETRY_CONTEXT_FIELDS', '["tool_name"]')
    const internalAccept = vi.fn()
    let sinks: Array<{ id: string; accept: (fact: unknown) => void }> = []
    const dispatcher = createTelemetryDispatcher(vi.fn(), {
      internalSinks: () => sinks,
      isInternalDeliveryEnabled: () => true,
    })

    dispatcher.publish(pluginInvocationFact(undefined))
    sinks = [{ id: 'delayed', accept: internalAccept }]
    dispatcher.flushInternalSinks()
    await flushPromises()

    expect(internalAccept).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { pluginInvocation: { toolName: 'private_server.search' } },
      })
    )
  })

  const smartAppPolicyCases = [
    ['no fields', [], undefined],
    ['only the name', ['smart_app_name'], { name: 'Research' }],
    ['only the key', ['smart_app_key'], { key: 'research' }],
    [
      'a partial combination',
      ['smart_app_key', 'smart_app_source'],
      { key: 'research', source: 'market' },
    ],
    [
      'all fields',
      ['smart_app_key', 'smart_app_name', 'smart_app_version', 'smart_app_source'],
      { key: 'research', name: 'Research', version: '1.0.0', source: 'market' },
    ],
  ] as const

  for (const delivery of ['immediate', 'queued'] as const) {
    test.each(smartAppPolicyCases)(
      `delivers %s to ${delivery} sinks`,
      async (_label, contextFields, expectedSmartApp) => {
        const internalAccept = await deliverSmartAppFact(contextFields, delivery)

        expect(internalAccept).toHaveBeenCalledOnce()
        const envelope = internalAccept.mock.calls[0]?.[0] as SmartAppSinkEnvelope
        if (expectedSmartApp === undefined) {
          expect(envelope).not.toHaveProperty('context')
        } else {
          expect(envelope.context).toEqual({ smartApp: expectedSmartApp })
        }
      }
    )
  }

  const invalidSmartAppValueCases = [
    ['a blank name', { name: '   ' }, { key: 'research', version: '1.0.0', source: 'market' }],
    [
      'an oversized version',
      { version: 'v'.repeat(257) },
      { key: 'research', name: 'Research', source: 'market' },
    ],
    [
      'an unknown source',
      { source: 'private' },
      { key: 'research', name: 'Research', version: '1.0.0' },
    ],
  ] as const

  for (const delivery of ['immediate', 'queued'] as const) {
    test.each(invalidSmartAppValueCases)(
      `omits %s while keeping valid fields for ${delivery} sinks`,
      async (_label, smartAppOverrides, expectedSmartApp) => {
        const internalAccept = await deliverSmartAppFact(
          ['smart_app_key', 'smart_app_name', 'smart_app_version', 'smart_app_source'],
          delivery,
          smartAppOverrides
        )

        expect(internalAccept).toHaveBeenCalledOnce()
        expect((internalAccept.mock.calls[0]?.[0] as SmartAppSinkEnvelope).context).toEqual({
          smartApp: expectedSmartApp,
        })
      }
    )
  }

  test('does not buffer internal facts while unified telemetry is disabled', async () => {
    const internalAccept = vi.fn()
    let enabled = false
    const dispatcher = createTelemetryDispatcher(vi.fn(), {
      internalSinks: () => [{ id: 'internal', accept: internalAccept }],
      isInternalDeliveryEnabled: () => enabled,
    })

    dispatcher.publish(smartAppFact('smart_app_opened'))
    enabled = true
    dispatcher.flushInternalSinks()
    await flushPromises()

    expect(internalAccept).not.toHaveBeenCalled()
  })
})
