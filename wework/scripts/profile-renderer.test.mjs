// @vitest-environment node
import { runInNewContext } from 'node:vm'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SourceMap } from 'node:module'
import { expect, test } from 'vitest'
import {
  formatRendererThreadTiming,
  installTurnUpdateProbe,
  peakTenSecondCpu,
  stopRendererThreadTiming,
  summarizeRendererFunctions,
} from './profile-renderer.mjs'

test('preserves the idle window without exporting the gap before the task', () => {
  const event = { pid: 10, tid: 2 }
  const trace = {
    traceEvents: [
      { ...event, ph: 'I', name: 'wework-profile:idle-start', ts: 1 },
      { ...event, ph: 'X', name: 'RunTask', ts: 2, dur: 3, tdur: 2 },
      { ...event, ph: 'I', name: 'wework-profile:idle-end', ts: 8 },
      { ...event, ph: 'X', name: 'RunTask', ts: 9, dur: 2 },
      { ...event, ph: 'I', name: 'wework-profile:single-task-start', ts: 15 },
      { ...event, ph: 'X', name: 'RunTask', ts: 16, dur: 2 },
      { ...event, ph: 'I', name: 'wework-profile:single-task-end', ts: 25 },
    ],
  }
  const result = formatRendererThreadTiming(trace, [10])
  expect(result.idleWindowUs).toEqual({ start: 1, end: 8 })
  expect(result.traceEvents.filter(({ ph }) => ph === 'X')).toEqual([
    trace.traceEvents[1],
    trace.traceEvents[5],
  ])
})

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
    idleWindowUs: { start: null, end: null },
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

function functionEvidence() {
  const event = { pid: 10, tid: 2 }
  return {
    trace: {
      traceEvents: [
        { ...event, ph: 'I', name: 'wework-profile:idle-start', ts: 100 },
        {
          ...event,
          ph: 'X',
          name: 'FunctionCall',
          ts: 105,
          dur: 10,
          tdur: 6,
          args: { data: { scriptId: 1, lineNumber: 1, columnNumber: 1, url: 'PRIVATE_CANARY' } },
        },
        { ...event, ph: 'I', name: 'wework-profile:idle-end', ts: 140 },
        { ...event, ph: 'I', name: 'wework-profile:single-task-start', ts: 160 },
        {
          ...event,
          ph: 'X',
          name: 'FunctionCall',
          ts: 170,
          dur: 10,
          args: { data: { scriptId: '1', lineNumber: 1, columnNumber: 1 } },
        },
        { ...event, pid: 11, ph: 'X', name: 'FunctionCall', ts: 175, dur: 10, tdur: 9 },
        { ...event, ph: 'I', name: 'wework-profile:single-task-end', ts: 200 },
      ],
    },
    profile: {
      startTime: 100,
      endTime: 210,
      nodes: [
        {
          id: 1,
          callFrame: {
            scriptId: '0',
            functionName: 'PRIVATE_CANARY',
            lineNumber: -1,
            columnNumber: -1,
          },
          children: [2],
        },
        {
          id: 2,
          callFrame: {
            scriptId: '1',
            url: 'https://private.invalid/?key=PRIVATE_CANARY',
            functionName: 'PRIVATE_CANARY',
            lineNumber: 0,
            columnNumber: 0,
          },
        },
      ],
      samples: [2, 2, 2],
      timeDeltas: [20, 40, 40],
    },
  }
}

test('separates invocation counts from clipped V8 samples and missing thread time', () => {
  const { trace, profile } = functionEvidence()
  const maps = new Map([
    [
      '1',
      new SourceMap({
        version: 3,
        sources: ['wework/scripts/profile-renderer.mjs'],
        names: [],
        mappings: 'AAAA',
      }),
    ],
  ])
  const result = summarizeRendererFunctions(trace, [10], profile, maps)
  expect(result.idle.functions[0]).toMatchObject({
    source: 'wework/scripts/profile-renderer.mjs',
    samples: 2,
    sampledSelfMs: 0.04,
    sampledInclusiveMs: 0.04,
    calls: 1,
    callWallMs: 0.01,
    callThreadMs: 0.006,
    callsWithoutThreadTime: 0,
  })
  expect(result.singleTask.functions[0]).toMatchObject({
    samples: 1,
    sampledSelfMs: 0.04,
    calls: 1,
    callThreadMs: 0,
    callsWithoutThreadTime: 1,
  })
  expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY')
})

test('reports absent, stale, malformed profiles and missing idle markers explicitly', () => {
  const { trace, profile } = functionEvidence()
  expect(summarizeRendererFunctions(trace, [10]).idle.status).toBe('no-profile')
  expect(
    summarizeRendererFunctions(trace, [10], { ...profile, startTime: 1, endTime: 50 }).idle.status
  ).toBe('stale-profile')
  expect(summarizeRendererFunctions(trace, [10], { ...profile, samples: [999] }).idle.status).toBe(
    'invalid-profile'
  )
  expect(
    summarizeRendererFunctions(trace, [10], { ...profile, timeDeltas: [-1, 40, 40] }).idle.status
  ).toBe('invalid-profile')
  const noIdle = { traceEvents: trace.traceEvents.filter(event => !event.name.includes('idle')) }
  expect(summarizeRendererFunctions(noIdle, [10], profile).idle.status).toBe('missing-window')
  expect(summarizeRendererFunctions(noIdle, [10], profile).singleTask.status).toBe('available')
})

test('exports a safe sidecar through the existing recorder stop seam and cleans its state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'renderer-safe-timing-'))
  const output = join(directory, 'renderer-performance-timing.json')
  const { trace, profile } = functionEvidence()
  const map = {
    version: 3,
    sources: ['wework/scripts/profile-renderer.mjs', '../PRIVATE_CANARY.ts'],
    names: ['PRIVATE_CANARY'],
    sourcesContent: ['PRIVATE_CANARY'],
    mappings: 'AAAA',
  }
  const metadata = {
    method: 'Debugger.scriptParsed',
    params: {
      scriptId: '1',
      url: pathToFileURL(join(directory, 'app.js')).href,
      sourceMapURL: `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`,
    },
  }
  const commands = []
  let currentProfile = profile
  let dataLoss = true
  const client = async input => {
    commands.push(input.method ?? input.action)
    if (input.method === 'Profiler.stop') return { profile: currentProfile }
    if (input.action === 'events')
      return {
        events: [
          metadata,
          {
            method: 'Tracing.tracingComplete',
            params: { stream: 'trace', dataLossOccurred: dataLoss },
          },
        ],
        next: 2,
        latest: 2,
        lost: 4,
        attached: true,
      }
    if (input.method === 'IO.read') return { data: JSON.stringify(trace), eof: true }
    return {}
  }
  const idle = {
    start: { seconds: 1, userSeconds: 0.8, systemSeconds: 0.2, time: 10 },
    end: { seconds: 1.2, userSeconds: 0.9, systemSeconds: 0.3, time: 7010 },
  }
  const state = () =>
    writeFile(
      join(directory, 'performance-1.json'),
      JSON.stringify({
        target: 1,
        after: 0,
        lostEvents: 2,
        metadataLostEvents: 3,
        metadata: [],
        credentials: 'PRIVATE_CANARY',
      })
    )
  try {
    await state()
    await stopRendererThreadTiming(client, directory, 1, output, [10], idle)
    const report = JSON.parse(await readFile(output, 'utf8'))
    expect(report.idleCpuWindow).toEqual(idle)
    expect(report.traceDataLoss).toBe(true)
    expect(report.evidence).toEqual({
      protocolLostEvents: 6,
      metadataLostEvents: 3,
      sourceMapsUnavailable: 0,
    })
    expect(report.functions.idle.functions[0]).toMatchObject({
      source: 'wework/scripts/profile-renderer.mjs',
      calls: 1,
      samples: 2,
    })
    expect(JSON.stringify(report)).not.toContain('PRIVATE_CANARY')
    expect(commands.indexOf('Tracing.end')).toBeLessThan(commands.indexOf('Debugger.enable'))
    expect(commands).not.toContain('Profiler.start')
    expect(commands.at(-1)).toBe('Debugger.disable')
    await expect(readFile(output + '.evidence.json')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(directory, 'performance-1.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    // A second invocation must not reuse the prior profile or map.
    currentProfile = undefined
    dataLoss = false
    await state()
    await stopRendererThreadTiming(client, directory, 1, output, [10], idle)
    const absent = JSON.parse(await readFile(output, 'utf8'))
    expect(absent.traceDataLoss).toBe(false)
    expect(absent.functions.idle.status).toBe('no-profile')
    expect(absent.functions.idle.functions).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects a recorder belonging to a different target before issuing commands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'renderer-wrong-target-'))
  try {
    await writeFile(join(directory, 'performance-1.json'), JSON.stringify({ target: 2 }))
    let commands = 0
    await expect(
      stopRendererThreadTiming(
        async () => {
          commands++
          return {}
        },
        directory,
        1,
        join(directory, 'report.json'),
        [10]
      )
    ).rejects.toThrow('another renderer')
    expect(commands).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
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
