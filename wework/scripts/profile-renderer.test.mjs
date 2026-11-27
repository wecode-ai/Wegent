// @vitest-environment node
import { runInNewContext } from 'node:vm'
import { expect, test } from 'vitest'
import { installTurnUpdateProbe, peakTenSecondCpu } from './profile-renderer.mjs'
import {
  summarizeJavascriptProfile,
  summarizeNativeSample,
} from './profile-renderer-native-diagnostics.mjs'

test('retains exclusive native stack counts without process headers or paths', () => {
  const sample = `Process: WeWork Helper [42]
Path: /Users/runner/private/credential-value/WeWork
Call graph:
    10 Thread_123 DispatchQueue_1: CrRendererMain
    + 10 start (in Electron Framework) [0x1234]
    +   8 Render (in Electron Framework) [0x1235]
    +     5 ParseMarkdown (in Electron Framework) [0x1236]
    +     3 mach_msg_trap (in libsystem_kernel.dylib) [0x1237]
    +   2 Update (in Electron Framework) [0x1238]
    10 Thread_456
    + 10 v8::internal::SamplingThread::Run (in Electron Framework) [0x1239]
    +   10 Sleep (in libsystem_kernel.dylib) [0x1240]
    10 Thread_789: V8 Profiler
    + 10 Sleep (in libsystem_kernel.dylib) [0x1241]
Total number in stack (recursive counted multiple, when >=5):
Binary Images:
0x1234 /Users/runner/private/credential-value/WeWork
`
  expect(summarizeNativeSample(sample)).toEqual([
    {
      category: 'renderer-main',
      samples: 10,
      functions: [
        { function: 'ParseMarkdown', samples: 5 },
        { function: 'mach_msg_trap', samples: 3 },
        { function: 'Update', samples: 2 },
      ],
    },
    { category: 'v8-profiler', samples: 10, functions: [{ function: 'Sleep', samples: 10 }] },
    { category: 'v8-profiler', samples: 10, functions: [{ function: 'Sleep', samples: 10 }] },
  ])
  expect(summarizeNativeSample('Sampling failed: credential-value')).toEqual([])
})

test('summarizes JS self time without source URLs, source text or unexpected frame names', () => {
  expect(
    summarizeJavascriptProfile({
      startTime: 1000,
      endTime: 5000,
      nodes: [
        { id: 1, callFrame: { functionName: '(idle)', lineNumber: -1, columnNumber: -1 } },
        {
          id: 2,
          callFrame: {
            functionName: 'Render',
            lineNumber: 10,
            columnNumber: 20,
            url: 'https://service/?key=credential-value',
          },
        },
        {
          id: 3,
          callFrame: {
            functionName: 'https://service/?key=credential-value',
            lineNumber: 1,
            columnNumber: 1,
          },
        },
      ],
      samples: [2, 1, 2, 3],
      timeDeltas: [1000, 1000, 500, 500],
    })
  ).toEqual({
    durationMs: 4,
    functions: [
      { function: 'Render', line: 11, column: 21, samples: 2, selfMs: 1.5 },
      { function: '(idle)', line: 0, column: 0, samples: 1, selfMs: 1 },
      { function: '(unresolved)', line: 2, column: 2, samples: 1, selfMs: 0.5 },
    ],
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
