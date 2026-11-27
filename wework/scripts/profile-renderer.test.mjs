// @vitest-environment node
import { runInNewContext } from 'node:vm'
import { expect, test } from 'vitest'
import {
  formatRendererThreadTiming,
  installTurnUpdateProbe,
  peakTenSecondCpu,
} from './profile-renderer.mjs'
import { readRendererCatalogActivity } from './renderer-profile-diagnostics.mjs'

test('exports only allowlisted renderer trace timing and preserves missing thread duration', () => {
  const primary = { pid: 10, tid: 2 }
  const worker = { pid: 10, tid: 3 }
  const args = { request: { headers: { authorization: 'private' } } }
  const trace = {
    metadata: { args },
    traceEvents: [
      { ...primary, ph: 'M', name: 'thread_name', args: { ...args, name: 'CrRendererMain' } },
      { ...worker, ph: 'M', name: 'thread_name', args: { name: 'V8Worker' } },
      { ...primary, tid: 4, ph: 'M', name: 'thread_name', args: { name: 'private' } },
      { ...primary, ph: 'X', name: 'RunTask', ts: 1, dur: 8, tdur: 6 },
      { ...primary, ph: 'I', name: 'wework-profile:turn-started', ts: 10, args },
      { ...primary, ph: 'I', name: 'wework-profile:single-task-start', ts: 15 },
      { ...primary, ph: 'X', name: 'RunTask', ts: 15, dur: 8, tdur: 6, tts: 2, args },
      { ...worker, ph: 'X', name: 'V8.GC_MC_BACKGROUND_MARKING', ts: 15, dur: 5, args },
      { ...primary, ph: 'X', name: 'ResourceSendRequest', ts: 15, dur: 5, tdur: 5, args },
      { ...primary, pid: 11, ph: 'X', name: 'RunTask', ts: 15, dur: 8, tdur: 8 },
      { ...primary, ph: 'I', name: 'wework-profile:single-task-end', ts: 25 },
      { ...primary, ph: 'I', name: 'wework-profile:turn-settled', ts: 30 },
      { ...primary, ph: 'X', name: 'RunTask', ts: 31, dur: 8, tdur: 7 },
    ],
  }
  expect(formatRendererThreadTiming(trace, [10])).toEqual({
    singleTaskWindowUs: { start: 15, end: 25 },
    traceEvents: [
      { ...primary, ph: 'M', name: 'thread_name', ts: 0, args: { name: 'CrRendererMain' } },
      { ...worker, ph: 'M', name: 'thread_name', ts: 0, args: { name: 'V8Worker' } },
      { ...primary, ph: 'I', name: 'wework-profile:turn-started', ts: 10, s: 't' },
      { ...primary, ph: 'I', name: 'wework-profile:single-task-start', ts: 15, s: 't' },
      { ...primary, ph: 'X', name: 'RunTask', ts: 15, dur: 8, tdur: 6, tts: 2 },
      { ...worker, ph: 'X', name: 'V8.GC_MC_BACKGROUND_MARKING', ts: 15, dur: 5 },
      { ...primary, ph: 'I', name: 'wework-profile:single-task-end', ts: 25, s: 't' },
      { ...primary, ph: 'I', name: 'wework-profile:turn-settled', ts: 30, s: 't' },
    ],
  })
})

test('retains CPU counters and only packaged renderer asset locations', () => {
  const origin = 'http://127.0.0.1:4100'
  const frame = (url, functionName = 'private-dynamic-name') => ({
    url,
    functionName,
    lineNumber: 12,
    columnNumber: 34,
    scriptId: 'private-script',
  })
  const urls = [
    `${origin}/wework/app/assets/Workload-A1b2C3d4.js?token=private-token#private-fragment`,
    'https://private-external.test/wework/app/assets/Workload-A1b2C3d4.js',
    'http://127.0.0.1:4101/wework/app/assets/Workload-A1b2C3d4.js',
    `${origin}/wework/app/assets/private-without-hash.js`,
    'file:///Users/private-user/secret.js',
    'data:text/javascript,private-source',
  ]
  const profile = {
    startTime: 100,
    endTime: 200,
    nodes: [
      { id: 1, callFrame: frame('', '(root)'), children: [2], hitCount: 0 },
      ...urls.map((url, index) => ({
        id: index + 2,
        callFrame: frame(url),
        hitCount: 1,
        args: { authorization: 'private-authorization' },
      })),
    ],
    samples: [2, 3],
    timeDeltas: [10, 20],
    privateField: 'private-profile',
  }

  const result = formatRendererThreadTiming({ traceEvents: [] }, [10], profile, origin)

  expect(result.cpuProfile).toEqual({
    startTime: 100,
    endTime: 200,
    nodes: [
      { id: 1, callFrame: { category: 'root' }, children: [2], hitCount: 0 },
      {
        id: 2,
        callFrame: {
          category: 'application',
          asset: 'Workload-A1b2C3d4.js',
          lineNumber: 12,
          columnNumber: 34,
        },
        children: [],
        hitCount: 1,
      },
      ...urls.slice(1).map((_, index) => ({
        id: index + 3,
        callFrame: { category: 'non-application' },
        children: [],
        hitCount: 1,
      })),
    ],
    samples: [2, 3],
    timeDeltas: [10, 20],
  })
  expect(JSON.stringify(result)).not.toContain('private')
  expect(JSON.stringify(result)).not.toContain('127.0.0.1')
})

test('reads E2E counters without scanning retained marks or importing renderer helpers', () => {
  const state = { total: { started: 3, completed: 1, failed: 0, pending: 2 } }
  const read = () =>
    runInNewContext(`(${readRendererCatalogActivity.toString()})()`, {
      [Symbol.for('wework:e2e:plugin-activity')]: state,
      performance: {
        getEntriesByName: () => {
          throw new Error('Counter reads must not scan historical marks')
        },
      },
    })

  expect(read()).toEqual({ started: 3, completed: 1, failed: 0, pending: 2 })
  state.total.failed++
  state.total.pending--
  expect(read()).toEqual({ started: 3, completed: 1, failed: 1, pending: 1 })
  state.total.completed++
  state.total.pending--
  expect(read()).toEqual({ started: 3, completed: 2, failed: 1, pending: 0 })
  expect(runInNewContext(`(${readRendererCatalogActivity.toString()})()`)).toEqual({
    started: 0,
    completed: 0,
    failed: 0,
    pending: 0,
  })
})

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
  const microtasks = []
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
    queueMicrotask: callback => microtasks.push(callback),
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
  now = 55
  microtasks.shift()()
  emit('other', 'settled', 410)
  expect(probe.waitForSettled('other', 1000)).toBe(true)
  const settled = probe.waitForSettled('measured', 1000)
  emit('measured', 'settled', 500)
  expect(await settled).toBe(true)

  expect(probe.stop('measured')).toEqual([
    {
      status: 'started',
      observedAt: 25,
      longTaskMs: 180,
      longTaskStartMs: 20,
      afterDeliveryAt: 55,
    },
    { status: 'settled', observedAt: 500, longTaskMs: 0 },
  ])
  expect(listeners.size).toBe(0)
})
