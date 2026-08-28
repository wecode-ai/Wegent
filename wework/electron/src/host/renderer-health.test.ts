import { describe, expect, test, vi } from 'vitest'
import { RendererHealthService } from './renderer-health.js'

describe('RendererHealthService', () => {
  test('tracks loading, ready, unresponsive, and responsive transitions', () => {
    const service = new RendererHealthService({ now: () => 1_000 })
    const listener = vi.fn()
    service.on('change', listener)

    service.loading()
    service.ready()
    service.unresponsive()
    service.responsive()

    expect(service.snapshot()).toMatchObject({
      state: 'ready',
      generation: 1,
      crashCount: 0,
      reason: null,
    })
    expect(listener.mock.calls.map(call => call[0].state)).toEqual([
      'loading',
      'ready',
      'unresponsive',
      'ready',
    ])
  })

  test('allows bounded recreation before entering failed state', () => {
    let now = 0
    const service = new RendererHealthService({
      maxAutomaticRecreations: 2,
      crashWindowMs: 1_000,
      now: () => now,
    })

    expect(service.crashed('first')).toBe(true)
    service.recreating()
    service.loading()
    now += 100
    expect(service.crashed('second')).toBe(true)
    service.recreating()
    service.loading()
    now += 100
    expect(service.crashed('third')).toBe(false)
    expect(service.snapshot()).toMatchObject({
      state: 'failed',
      generation: 2,
      crashCount: 3,
      reason: 'renderer_crash_limit',
    })
  })

  test('forgets crashes outside the configured window', () => {
    let now = 0
    const service = new RendererHealthService({
      maxAutomaticRecreations: 1,
      crashWindowMs: 100,
      now: () => now,
    })

    expect(service.crashed('first')).toBe(true)
    now = 101
    expect(service.crashed('later')).toBe(true)
    expect(service.snapshot().crashCount).toBe(1)
  })
})
