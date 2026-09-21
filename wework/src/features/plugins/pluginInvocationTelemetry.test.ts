import { beforeEach, describe, expect, test } from 'vitest'
import type { InstalledPlugin } from '@/types/api'
import { subscribeBusinessEvents } from '@/telemetry/businessEvents'
import {
  observeRuntimePluginInvocation,
  publishPluginInvocationCatalog,
  publishPluginInvocationDevices,
  publishPluginInvocationTask,
  resetPluginInvocationTelemetryForTest,
} from './pluginInvocationTelemetry'

function plugin(overrides: Partial<InstalledPlugin['spec']> = {}): InstalledPlugin {
  return {
    apiVersion: 'v1',
    kind: 'InstalledPlugin',
    metadata: { name: 'private-plugin' },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: 'wegent-market',
        pluginKey: 'private-plugin',
        marketplace: 'wegent',
      },
      displayName: 'Private plugin',
      description: '',
      installState: 'installed',
      enabled: true,
      manifest: {},
      components: {
        skills: [],
        commands: [],
        agents: [],
        hooks: [],
        mcps: [{ name: 'private_server', server: {} }],
        lsps: [],
        monitors: [],
        bins: [],
      },
      visibility: 'workspace',
      ...overrides,
    },
    status: { state: 'installed' },
  }
}

function event(
  eventName: 'response.block.created' | 'response.block.updated',
  data: Record<string, unknown>
) {
  return {
    event: eventName,
    payload: {
      taskId: 'task-1',
      subtaskId: 'turn-1',
      deviceId: 'device-1',
      data,
    },
  }
}

describe('plugin invocation telemetry', () => {
  beforeEach(() => resetPluginInvocationTelemetryForTest())

  test('reports one successful terminal event for a plugin-owned MCP call', () => {
    const events: Array<{ name: string; properties: unknown }> = []
    const unsubscribe = subscribeBusinessEvents(value => events.push(value))
    publishPluginInvocationCatalog('device-1', [plugin()], [])
    publishPluginInvocationDevices([
      {
        id: 1,
        device_id: 'device-1',
        name: 'Local',
        status: 'online',
        is_default: true,
        device_type: 'app',
      },
    ])
    publishPluginInvocationTask('device-1', 'task-1', {
      runtimeHandle: {
        origin: { type: 'board_task' },
      },
    })

    observeRuntimePluginInvocation(
      event('response.block.created', {
        block: {
          id: 'call-1',
          type: 'tool',
          tool_name: 'mcp__private_server__search',
          status: 'pending',
        },
      })
    )
    observeRuntimePluginInvocation(
      event('response.block.updated', {
        block_id: 'call-1',
        updates: { status: 'done', tool_output: 'private output' },
      })
    )
    observeRuntimePluginInvocation(
      event('response.block.updated', {
        block_id: 'call-1',
        updates: { status: 'done' },
      })
    )

    expect(events).toEqual([
      {
        context: {
          pluginInvocation: {
            marketplace: 'wegent',
            pluginKey: 'private-plugin',
            toolName: 'mcp__private_server__search',
            version: 'unknown',
          },
        },
        name: 'plugin_invocation_succeeded',
        properties: {
          capability_type: 'mcp',
          execution_surface: 'project_task',
          executor_location: 'local',
          plugin_distribution: 'enterprise',
        },
      },
    ])
    expect(JSON.stringify(events[0]?.properties)).not.toMatch(
      /private-plugin|private_server|private output/
    )
    unsubscribe()
  })

  test('reports a successful shell command executed from an installed plugin Skill', () => {
    const events: Array<{ name: string; properties: unknown; context?: unknown }> = []
    const unsubscribe = subscribeBusinessEvents(value => events.push(value))
    publishPluginInvocationCatalog(
      'device-1',
      [
        plugin({
          components: {
            skills: [
              {
                name: 'private-plugin',
                description: '',
                path: '/Users/test/.wework/codex/plugins/cache/wegent/private-plugin/1.0.0/skills/private-plugin/SKILL.md',
              },
            ],
            commands: [],
            agents: [],
            hooks: [],
            mcps: [],
            lsps: [],
            monitors: [],
            bins: [],
          },
          version: '1.0.0',
        }),
      ],
      []
    )
    publishPluginInvocationDevices([
      {
        id: 1,
        device_id: 'device-1',
        name: 'Local',
        status: 'online',
        is_default: true,
        device_type: 'app',
      },
    ])

    observeRuntimePluginInvocation(
      event('response.block.created', {
        block: {
          id: 'call-skill-1',
          type: 'tool',
          tool_name: 'exec_command',
          tool_input: {
            cmd: 'sh "/Users/test/.wework/codex/plugins/cache/wegent/private-plugin/1.0.0/scripts/run.sh" list',
          },
          status: 'done',
        },
      })
    )

    expect(events).toMatchObject([
      {
        name: 'plugin_invocation_succeeded',
        properties: {
          capability_type: 'skill',
          execution_surface: 'unknown',
          executor_location: 'local',
          plugin_distribution: 'enterprise',
        },
        context: {
          pluginInvocation: {
            marketplace: 'wegent',
            pluginKey: 'private-plugin',
            toolName: 'exec_command',
            version: '1.0.0',
          },
        },
      },
    ])
    unsubscribe()
  })

  test('does not treat an unrelated shell command as plugin usage', () => {
    const events: Array<{ name: string; properties: unknown }> = []
    const unsubscribe = subscribeBusinessEvents(value => events.push(value))
    publishPluginInvocationCatalog(
      'device-1',
      [
        plugin({
          components: {
            skills: [
              {
                name: 'private-plugin',
                description: '',
                path: '/Users/test/.wework/codex/plugins/cache/wegent/private-plugin/1.0.0/skills/private-plugin/SKILL.md',
              },
            ],
            commands: [],
            agents: [],
            hooks: [],
            mcps: [],
            lsps: [],
            monitors: [],
            bins: [],
          },
        }),
      ],
      []
    )

    observeRuntimePluginInvocation(
      event('response.block.created', {
        block: {
          id: 'call-shell-1',
          type: 'tool',
          tool_name: 'exec_command',
          tool_input: { cmd: 'pwd' },
          status: 'done',
        },
      })
    )

    expect(events).toEqual([])
    unsubscribe()
  })

  test('reports a failed terminal event and ignores unowned MCP calls', () => {
    const events: Array<{ name: string; properties: unknown }> = []
    const unsubscribe = subscribeBusinessEvents(value => events.push(value))
    publishPluginInvocationCatalog('device-1', [plugin({ visibility: 'personal' })], [])

    observeRuntimePluginInvocation(
      event('response.block.created', {
        block: {
          id: 'call-1',
          type: 'tool',
          tool_name: 'private_server__search',
          status: 'error',
        },
      })
    )
    observeRuntimePluginInvocation(
      event('response.block.created', {
        block: {
          id: 'call-2',
          type: 'tool',
          tool_name: 'wework_space.read',
          status: 'done',
        },
      })
    )

    expect(events).toEqual([
      {
        context: {
          pluginInvocation: {
            marketplace: 'wegent',
            pluginKey: 'private-plugin',
            toolName: 'private_server__search',
            version: 'unknown',
          },
        },
        name: 'plugin_invocation_failed',
        properties: {
          capability_type: 'mcp',
          execution_surface: 'unknown',
          executor_location: 'unknown',
          plugin_distribution: 'personal',
          failure_stage: 'invoke',
        },
      },
    ])
    unsubscribe()
  })

  test('does not report disabled plugin capabilities', () => {
    const events: Array<{ name: string; properties: unknown }> = []
    const unsubscribe = subscribeBusinessEvents(value => events.push(value))
    publishPluginInvocationCatalog('device-1', [plugin({ enabled: false })], [])

    observeRuntimePluginInvocation(
      event('response.block.created', {
        block: {
          id: 'call-1',
          type: 'tool',
          tool_name: 'mcp__private_server__search',
          status: 'done',
        },
      })
    )

    expect(events).toEqual([])
    unsubscribe()
  })

  test('reports a terminal tool block delivered in an updated event', () => {
    const events: Array<{ name: string; properties: unknown }> = []
    const unsubscribe = subscribeBusinessEvents(value => events.push(value))
    publishPluginInvocationCatalog('device-1', [plugin()], [])

    observeRuntimePluginInvocation(
      event('response.block.updated', {
        block: {
          id: 'call-1',
          type: 'tool',
          tool_name: 'mcp__private_server__search',
          status: 'done',
          durationMs: 42,
        },
      })
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      context: { pluginInvocation: { durationMs: 42 } },
      name: 'plugin_invocation_succeeded',
    })
    unsubscribe()
  })

  test('uses the update status when its full block carries a stale terminal status', () => {
    const events: Array<{ name: string; properties: unknown }> = []
    const unsubscribe = subscribeBusinessEvents(value => events.push(value))
    publishPluginInvocationCatalog('device-1', [plugin()], [])

    observeRuntimePluginInvocation(
      event('response.block.updated', {
        block_id: 'call-1',
        updates: { status: 'error', durationMs: 12 },
        block: {
          id: 'call-1',
          type: 'tool',
          plugin_id: 'private-plugin@wegent',
          tool_name: 'renamed-runtime-server.search',
          status: 'done',
        },
      })
    )

    expect(events[0]).toMatchObject({
      context: { pluginInvocation: { durationMs: 12 } },
      name: 'plugin_invocation_failed',
      properties: { failure_stage: 'invoke' },
    })
    unsubscribe()
  })

  test('uses executor plugin provenance when the installed summary has no MCP details', () => {
    const events: Array<{ name: string; properties: unknown }> = []
    const unsubscribe = subscribeBusinessEvents(value => events.push(value))
    publishPluginInvocationCatalog(
      'device-1',
      [plugin({ components: { ...plugin().spec.components, mcps: [] } })],
      []
    )

    observeRuntimePluginInvocation(
      event('response.block.created', {
        block: {
          id: 'call-1',
          type: 'tool',
          plugin_id: 'private-plugin@wegent',
          mcp_server: 'renamed-runtime-server',
          tool_name: 'renamed-runtime-server.search',
          status: 'error',
        },
      })
    )

    expect(events[0]).toMatchObject({
      context: { pluginInvocation: { pluginKey: 'private-plugin' } },
      name: 'plugin_invocation_failed',
      properties: { plugin_distribution: 'enterprise' },
    })
    unsubscribe()
  })

  test('does not guess ownership when two plugins declare the same MCP server', () => {
    const events: Array<{ name: string; properties: unknown }> = []
    const unsubscribe = subscribeBusinessEvents(value => events.push(value))
    publishPluginInvocationCatalog(
      'device-1',
      [
        plugin(),
        plugin({
          source: {
            type: 'marketplace',
            providerKey: 'wegent-market',
            pluginKey: 'other-plugin',
            marketplace: 'wegent',
          },
        }),
      ],
      []
    )

    observeRuntimePluginInvocation(
      event('response.block.created', {
        block: {
          id: 'call-1',
          type: 'tool',
          tool_name: 'mcp__private_server__search',
          status: 'done',
        },
      })
    )

    expect(events).toEqual([])
    unsubscribe()
  })
})
