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
})
