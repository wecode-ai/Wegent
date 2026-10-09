import { describe, expect, test, vi } from 'vitest'
import { StartupTelemetryLifecycle, StartupTelemetrySuccessGate } from './startup-telemetry'

describe('startup telemetry lifecycle', () => {
  test('publishes one correlated successful startup', () => {
    const publish = vi.fn()
    let now = 100
    const lifecycle = new StartupTelemetryLifecycle({
      id: 'startup-1',
      now: () => now,
      publish,
    })

    lifecycle.start()
    now = 432.4

    expect(lifecycle.succeed()).toBe(true)
    expect(lifecycle.fail('unknown')).toBe(false)
    expect(publish.mock.calls).toEqual([
      ['startup.attempted', { startup_id: 'startup-1' }],
      [
        'startup.succeeded',
        {
          startup_id: 'startup-1',
          duration_ms: 332,
        },
      ],
    ])
  })

  test('publishes the first failure stage and ignores later terminal outcomes', () => {
    const publish = vi.fn()
    let now = 20
    const lifecycle = new StartupTelemetryLifecycle({
      id: 'startup-2',
      now: () => now,
      publish,
    })

    lifecycle.start()
    now = 145

    expect(lifecycle.fail('desktop_runtime')).toBe(true)
    expect(lifecycle.succeed()).toBe(false)
    expect(publish).toHaveBeenLastCalledWith('startup.failed', {
      startup_id: 'startup-2',
      duration_ms: 125,
      failure_stage: 'desktop_runtime',
    })
  })

  test('publishes success only after both the renderer and desktop runtime are ready', () => {
    const publish = vi.fn()
    const lifecycle = new StartupTelemetryLifecycle({
      id: 'startup-3',
      now: () => 100,
      publish,
    })
    const successGate = new StartupTelemetrySuccessGate(lifecycle)

    lifecycle.start()

    expect(successGate.markRendererReady()).toBe(false)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(successGate.markRuntimeReady()).toBe(true)
    expect(publish).toHaveBeenLastCalledWith('startup.succeeded', {
      startup_id: 'startup-3',
      duration_ms: 0,
    })
    expect(successGate.markRendererReady()).toBe(false)
  })
})
