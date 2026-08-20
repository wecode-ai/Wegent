import { Context, type Plugin } from '@deepseek-ai/cordis'
import { describe, expect, test, vi } from 'vitest'

import { WorkbenchPluginRuntime } from './runtime'

describe('WorkbenchPluginRuntime', () => {
  test('loads dependent plugins and reverses route effects on disposal', async () => {
    const runtime = new WorkbenchPluginRuntime()
    const cleanup = vi.fn()
    const plugin = Object.assign(
      (ctx: Context) => {
        const disposeRoute = ctx.workbenchRoutes.register({
          id: 'test.route',
          path: '/test',
          telemetryFeature: 'test',
          render: () => null,
        })
        return () => {
          cleanup()
          disposeRoute()
        }
      },
      { inject: ['workbenchRoutes'] }
    ) as Plugin

    await runtime.initialize({
      id: 'test',
      entries: [{ id: 'test', plugin, required: false }],
    })

    expect(runtime.routes.resolve('/test')?.id).toBe('test.route')

    await runtime.dispose()

    expect(cleanup).toHaveBeenCalledOnce()
    expect(() => runtime.routes).toThrow('Workbench route service is not active')
  })

  test('rolls back an already loaded plugin when a later plugin fails', async () => {
    const runtime = new WorkbenchPluginRuntime()
    const cleanup = vi.fn()
    const first = (() => cleanup) as Plugin
    const failing = (() => {
      throw new Error('broken plugin')
    }) as Plugin

    await expect(
      runtime.initialize({
        id: 'broken-profile',
        entries: [
          { id: 'first', plugin: first, required: false },
          { id: 'failing', plugin: failing, required: false },
        ],
      })
    ).rejects.toThrow("Failed to initialize Wework plugin profile 'broken-profile'")
    expect(cleanup).toHaveBeenCalledOnce()
  })

  test('rejects a required plugin that is not pinned to the current client', async () => {
    const runtime = new WorkbenchPluginRuntime()

    await expect(
      runtime.initialize({
        id: 'invalid-required-profile',
        entries: [
          {
            id: 'required',
            plugin: (() => undefined) as Plugin,
            required: true,
            clientVersion: '0.0.0-invalid',
          },
        ],
      })
    ).rejects.toThrow("Failed to initialize Wework plugin profile 'invalid-required-profile'")
  })
})
