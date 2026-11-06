import { describe, expect, test } from 'vitest'

import {
  assertStartupSplashHandoff,
  STARTUP_SPLASH_HANDOFF_EVENTS,
} from '../../e2e/desktop/modules/startup-splash-handoff.mjs'

function handoffSnapshot(reducedMotion = false) {
  const timestamps = [0, 10, 11, 100, 350, 360, 370, reducedMotion ? 370 : 970]
  const bounds = { x: 100, y: 80, width: 1440, height: 960 }
  return {
    state: 'closed',
    events: STARTUP_SPLASH_HANDOFF_EVENTS.map((name: string, index: number) => ({
      name,
      timestamp: timestamps[index] ?? timestamps.at(-1)!,
    })),
    handoff: {
      fadeDurationMs: 600,
      reducedMotion,
      completion: {
        progressNow: 100,
        fillEnd: 1359,
        trackEnd: 1359,
        wordmarkVisible: false,
        canvas: { x: 0, y: 0, width: 1440, height: 960 },
        viewport: { width: 1440, height: 960 },
      },
      bounds: { splash: { ...bounds }, main: { ...bounds } },
    },
  }
}

describe('startup handoff regression evidence', () => {
  test('accepts a completed frame before a full native fade and geometry-preserving reveal', () => {
    const snapshot = handoffSnapshot()
    expect(assertStartupSplashHandoff(snapshot)).toBe(snapshot.handoff)
  })

  test('accepts reduced motion only with a completed frame and every lifecycle boundary', () => {
    const snapshot = handoffSnapshot(true)
    expect(assertStartupSplashHandoff(snapshot)).toBe(snapshot.handoff)
    snapshot.handoff.completion.progressNow = 99
    expect(() => assertStartupSplashHandoff(snapshot)).toThrow('did not reach 100%')
  })

  test.each([
    ['progressNow', 99, 'did not reach 100%'],
    ['fillEnd', 1000, 'physical track endpoint'],
    ['wordmarkVisible', true, 'wordmark is still visible'],
  ] as const)('rejects incorrect completed-frame %s', (property, value, message) => {
    const snapshot = handoffSnapshot()
    Object.assign(snapshot.handoff.completion, { [property]: value })
    expect(() => assertStartupSplashHandoff(snapshot)).toThrow(String(message))
  })

  test('rejects the previous footer-dependent canvas layout and native geometry jump', () => {
    const canvasSnapshot = handoffSnapshot()
    canvasSnapshot.handoff.completion.canvas.height = 800
    expect(() => assertStartupSplashHandoff(canvasSnapshot)).toThrow('full window')
    const boundsSnapshot = handoffSnapshot()
    boundsSnapshot.handoff.bounds.main.y += 20
    expect(() => assertStartupSplashHandoff(boundsSnapshot)).toThrow('moved or resized')
  })

  test('rejects an early native close or a missing completed-frame acknowledgement', () => {
    const shortened = handoffSnapshot()
    shortened.events.at(-2)!.timestamp -= 100
    shortened.events.at(-1)!.timestamp -= 100
    expect(() => assertStartupSplashHandoff(shortened)).toThrow('before its duration')
    const missing = handoffSnapshot()
    missing.events = missing.events.filter(event => event.name !== 'completed')
    expect(() => assertStartupSplashHandoff(missing)).toThrow('painted-completion')
  })
})
