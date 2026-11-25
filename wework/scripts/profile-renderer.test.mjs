// @vitest-environment node
import { runInNewContext } from 'node:vm'
import { expect, test } from 'vitest'
import { installTurnUpdateProbe, peakTenSecondCpu } from './profile-renderer.mjs'

test('uses full ten-second windows to measure the concurrent CPU peak', () => {
  expect(
    peakTenSecondCpu([
      { time: 0, seconds: 10 },
      { time: 5_000, seconds: 12.5 },
      { time: 10_000, seconds: 13 },
      { time: 15_000, seconds: 17.5 },
    ])
  ).toBe(50)
  expect(() => peakTenSecondCpu([{ time: 0, seconds: 10 }])).toThrow('ten-second CPU window')
})

test('attributes a main-thread long task to the matching native turn update', async () => {
  const window = {}
  let now
  const records = [
    { startTime: 20, duration: 180 },
    { startTime: 400, duration: 100 },
  ]
  class PerformanceObserver {
    observe() {}
    takeRecords() {
      return records
    }
    disconnect() {}
  }
  runInNewContext(`(${installTurnUpdateProbe.toString()})()`, {
    window,
    PerformanceObserver,
    performance: { now: () => now },
    setTimeout,
    clearTimeout,
  })

  const listeners = window.__WEWORK_E2E_RUNTIME_EVENT_LISTENERS__
  const probe = window.__weworkProfileTurnUpdates
  function emit(taskId, status, at) {
    now = at
    for (const listener of listeners) {
      listener({ event: 'runtime.turn.updated', payload: { taskId, data: { status, task: {} } } })
    }
  }

  emit('measured', 'started', 25)
  emit('other', 'settled', 410)
  expect(probe.waitForSettled('other', 1000)).toBe(true)
  const settled = probe.waitForSettled('measured', 1000)
  emit('measured', 'settled', 500)
  expect(await settled).toBe(true)

  expect(probe.stop('measured')).toEqual([
    { status: 'started', observedAt: 25, longTaskMs: 180, longTaskStartMs: 20 },
    { status: 'settled', observedAt: 500, longTaskMs: 0 },
  ])
  expect(listeners.size).toBe(0)
})
