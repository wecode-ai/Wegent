import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { SourceMap } from 'node:module'
import { availableParallelism, freemem, loadavg } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  handleModelMaintenanceRequest,
  readRawRequestBody,
} from '../e2e/desktop/modules/response-protocol.mjs'
import { shellCommandResponse } from '../e2e/desktop/modules/shell-command-response.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR as pane,
  COMPOSER_SELECTOR as composer,
  assistantMessage,
  reasoningEvents,
  responseCompleted,
  responseCreated,
  sse,
  streamingEvents,
  textDeltaEvents,
  waitForBottom,
} from '../e2e/desktop/modules/streaming-text-fixture.mjs'
import { waitForWorkbenchDebugState } from '../e2e/desktop/modules/workspace-flows.mjs'
import { requestExecutor } from '../e2e/desktop/modules/executor-rpc.mjs'
import { waitForValue } from '../e2e/desktop/modules/workspace-agent-setup.mjs'
import { waitForClosedStartupSplash } from '../e2e/desktop/modules/native-window-state.mjs'
import { withTimeout } from '../e2e/desktop/modules/shared.mjs'
import {
  createDevtoolsClient,
  readLocalSourceMap,
  readProtocolStream,
  startPerformanceRecording,
  stopPerformanceRecording,
  writeDiagnosticFile,
} from './ai-verify-devtools.mjs'

const run = promisify(execFile)
const prompt = 'WEWORK_CPU_BENCHMARK_SINGLE_TASK'
const prefix = 'RENDERER_CPU_BENCHMARK_STREAM_STARTED'
const suffix = 'RENDERER_CPU_BENCHMARK_STREAM_FINISHED'
const warmupPrompt = 'WEWORK_CPU_BENCHMARK_WARMUP'
const warmupText = 'RENDERER_CPU_BENCHMARK_WARMUP_COMPLETE'
const idleSamples = 7
const sampleIntervalMs = 1000
const streamPieces = 120
const streamIntervalMs = 100
const historyPrompt = 'WEWORK_RENDERER_BENCHMARK_HISTORY_'
const historyTaskCount = 16
const concurrentTaskCount = 10
const concurrentPrompt = 'WEWORK_CPU_BENCHMARK_CONCURRENT_'
const concurrentStreamPieces = 390
const projectIssueCount = 480
// The sampled App had 267 unarchived local task records, including running work.
const persistedTaskCount = 257
// Use a populated tool history within the range observed near the recorded window.
const foregroundToolCalls = 180
const foregroundToolBatch = 24
const foregroundCpuSamplePieces = [25, 50, 75, 100, 125, 150, 175, 200]
const pendingGoalUpdatePieces = [255, 295, 335]
const pendingScrollPieces = [245, 265, 285, 305, 325, 345]
const measuredToolPieces = [35, 70, 105, 140, 175]
const measuredToolTasks = new Set(['01', '02', '03', '04'])
const measuredToolBatch = 2
const concurrentClockTask = '05'
const measuredReasoningTasks = new Set(['01', '02', '03'])
const measuredReasoningPieces = 25
const limits = {
  idleCpuPercent: 3,
  singleTaskCpuPercent: 15,
  tenTaskCpuPercent: 20,
  maxTurnUpdateLongTaskMs: 100,
  peakObservedJsHeapBytes: 200_000_000,
}

const rendererTimingEvents = new Set([
  'RunTask',
  'ProcessTask',
  'FunctionCall',
  'EvaluateScript',
  'V8.Execute',
  'Layout',
  'UpdateLayoutTree',
  'Paint',
  'Commit',
  'RasterTask',
  'MajorGC',
  'MinorGC',
])
const rendererTimingMarkers = new Set([
  'wework-profile:idle-start',
  'wework-profile:idle-end',
  'wework-profile:single-task-start',
  'wework-profile:single-task-end',
  'wework-profile:turn-started',
  'wework-profile:turn-settled',
])
const rendererThreadName =
  /^(?:CrRendererMain|Compositor|CompositorTileWorker\d*|ThreadPool(?:Foreground|Background)Worker|V8Worker|DedicatedWorker thread|ServiceWorkerThread|Chrome_ChildIOThread)$/

// Export only renderer timing data. The source trace and CDP events can
// contain request headers, application data, and arbitrary script arguments.
export function formatRendererThreadTiming(trace, rendererPids) {
  const rendererEvents = trace.traceEvents.filter(({ pid }) => rendererPids.includes(pid))
  const markers = rendererEvents.filter(
    ({ name, ph, ts }) => ph === 'I' && rendererTimingMarkers.has(name) && Number.isFinite(ts)
  )
  const start = markers.find(({ name }) => name === 'wework-profile:single-task-start')?.ts
  const end = markers.findLast(({ name }) => name === 'wework-profile:single-task-end')?.ts
  const turnStart = markers.find(({ name }) => name === 'wework-profile:turn-started')?.ts
  const turnEnd = markers.findLast(({ name }) => name === 'wework-profile:turn-settled')?.ts
  const idleStart = markers.find(({ name }) => name === 'wework-profile:idle-start')?.ts
  const idleEnd = markers.findLast(({ name }) => name === 'wework-profile:idle-end')?.ts
  const evidenceStart = turnStart === undefined ? start : Math.min(turnStart, start ?? turnStart)
  const evidenceEnd = turnEnd === undefined ? end : Math.max(turnEnd, end ?? turnEnd)
  const windows = [
    [idleStart, idleEnd],
    [evidenceStart, evidenceEnd],
  ].filter(([first, last]) => Number.isFinite(first) && Number.isFinite(last) && last > first)
  const traceEvents = rendererEvents.flatMap(({ name, ph, pid, tid, ts, dur, tdur, tts, args }) => {
    if (!Number.isInteger(tid)) return []
    if (ph === 'M' && name === 'thread_name' && rendererThreadName.test(args?.name))
      return [{ name, ph, pid, tid, ts: 0, args: { name: args.name } }]
    if (ph === 'I' && rendererTimingMarkers.has(name) && Number.isFinite(ts))
      return [{ name, ph, pid, tid, ts, s: 't' }]
    if (
      ph !== 'X' ||
      (!rendererTimingEvents.has(name) && !/^V8\.GC[A-Z0-9_a-z]+$/.test(name)) ||
      !Number.isFinite(ts) ||
      !Number.isFinite(dur) ||
      dur < 0 ||
      !windows.some(([first, last]) => ts + dur >= first && ts <= last)
    )
      return []
    return [
      {
        name,
        ph,
        pid,
        tid,
        ts,
        dur,
        // Thread time is optional. Wall time cannot substitute for CPU time.
        ...(Number.isFinite(tdur) && { tdur }),
        ...(Number.isFinite(tts) && { tts }),
      },
    ]
  })
  return {
    idleWindowUs: { start: idleStart ?? null, end: idleEnd ?? null },
    singleTaskWindowUs: { start: start ?? null, end: end ?? null },
    traceEvents,
  }
}

// The names and source contents in a profile/map may contain arbitrary values.
// Identify functions by verified repository locations, never by raw V8 names/URLs.
async function repositorySource(source, repositoryRoot) {
  if (typeof source !== 'string' || /[?#\0]/.test(source)) return null
  let path = source.replaceAll('\\', '/')
  if (path.startsWith('file:')) {
    try {
      path = fileURLToPath(path)
    } catch {
      return null
    }
  } else if (/^[a-z]+:/i.test(path)) return null
  if (!isAbsolute(path)) {
    path = path.replace(/^(?:\.\.\/)+/, '')
    if (path.startsWith('src/')) path = 'wework/' + path
    path = resolve(repositoryRoot, path)
  }
  try {
    const actual = await realpath(path)
    const within = relative(repositoryRoot, actual).replaceAll('\\', '/')
    if (
      !/^(?:wework\/(?:src|scripts|e2e)\/|packages\/[\w-]+\/)[\w./-]+\.[cm]?[jt]sx?$/.test(
        within
      ) ||
      within.split('/').includes('..')
    )
      return null
    return within
  } catch {
    return null
  }
}

async function rendererFunctionMaps(
  client,
  target,
  profile,
  metadata,
  root,
  deadline,
  applicationUrl
) {
  const maps = new Map()
  const used = new Set(profile?.nodes?.map(node => node.callFrame?.scriptId) ?? [])
  const scripts = new Map(
    metadata
      .filter(event => event.method === 'Debugger.scriptParsed')
      .map(event => [event.params.scriptId, event.params])
  )
  const frames = new Map(
    metadata
      .filter(event => event.method === 'Runtime.executionContextCreated')
      .map(event => [event.params.context.id, event.params.context.auxData?.frameId])
  )
  let unavailable = 0
  let loaded = 0
  const sourceCache = new Map()
  for (const id of used) {
    if (!id || id === '0') continue
    const script = scripts.get(id)
    if (!script?.sourceMapURL) {
      unavailable++
      continue
    }
    if (loaded >= 32 || performance.now() >= deadline) {
      unavailable++
      continue
    }
    loaded++
    try {
      const url = new URL(script.sourceMapURL, script.url)
      let text
      if (url.protocol === 'data:' && url.href.length < 16_000_000) {
        const comma = url.href.indexOf(',')
        text = /;base64,/.test(url.href)
          ? Buffer.from(url.href.slice(comma + 1), 'base64').toString('utf8')
          : decodeURIComponent(url.href.slice(comma + 1))
      } else if (url.protocol === 'file:') {
        text = await readLocalSourceMap(url, root)
      } else {
        const base = new URL(script.url)
        const ownedOrigin = applicationUrl && new URL(applicationUrl).origin === url.origin
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          (!ownedOrigin && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) ||
          url.origin !== base.origin ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !/\/assets\/[\w.-]+\.js\.map$/.test(url.pathname)
        )
          throw new Error('Unavailable map')
        const boundedCommand = (method, params) =>
          withTimeout(
            client({ action: 'command', target, method, params }),
            Math.max(1, deadline - performance.now()),
            'Renderer source map unavailable'
          )
        const { resource } = await boundedCommand('Network.loadNetworkResource', {
          frameId: frames.get(script.executionContextId),
          url: url.href,
          options: { disableCache: false, includeCredentials: false },
        })
        if (!resource.success || !resource.stream) throw new Error('Unavailable map')
        text = await readProtocolStream(boundedCommand, resource.stream)
      }
      const payload = JSON.parse(text)
      const sources = []
      for (const original of payload.sources ?? []) {
        const source = (payload.sourceRoot ?? '') + original
        if (!sourceCache.has(source) && performance.now() < deadline)
          sourceCache.set(source, await repositorySource(source, root))
        sources.push(sourceCache.get(source) ?? '')
      }
      // Omit sourcesContent and original names even from the in-memory mapping.
      maps.set(
        script.scriptId,
        new SourceMap({ version: 3, sources, names: [], mappings: payload.mappings })
      )
    } catch {
      unavailable++
    }
  }
  return { maps, unavailable }
}

export function summarizeRendererFunctions(trace, rendererPids, profile, maps = new Map()) {
  const timing = formatRendererThreadTiming(trace, rendererPids)
  const nodes = new Map(
    (Array.isArray(profile?.nodes) ? profile.nodes : []).map(node => [node.id, node])
  )
  const valid =
    profile &&
    Number.isFinite(profile.startTime) &&
    Number.isFinite(profile.endTime) &&
    profile.endTime > profile.startTime &&
    Array.isArray(profile.samples) &&
    Array.isArray(profile.timeDeltas) &&
    profile.samples.length === profile.timeDeltas.length &&
    Array.isArray(profile.nodes) &&
    nodes.size === profile.nodes.length &&
    profile.timeDeltas.every(delta => Number.isFinite(delta) && delta >= 0) &&
    profile.samples.every(id => nodes.has(id))
  const parents = new Map()
  for (const node of nodes.values())
    for (const child of node.children ?? []) parents.set(child, node.id)
  const location = frame => {
    if (
      !frame ||
      !Number.isInteger(frame.lineNumber) ||
      frame.lineNumber < 0 ||
      !Number.isInteger(frame.columnNumber) ||
      frame.columnNumber < 0
    )
      return null
    const entry = maps.get(String(frame.scriptId))?.findEntry(frame.lineNumber, frame.columnNumber)
    if (
      !entry?.originalSource ||
      !/^(?:wework\/(?:src|scripts|e2e)\/|packages\/[\w-]+\/)[\w./-]+\.[cm]?[jt]sx?$/.test(
        entry.originalSource
      ) ||
      entry.originalSource.split('/').includes('..')
    )
      return null
    return {
      source: entry.originalSource,
      line: entry.originalLine + 1,
      column: entry.originalColumn + 1,
    }
  }
  const phases = {}
  for (const [phase, window] of Object.entries({
    idle: timing.idleWindowUs,
    singleTask: timing.singleTaskWindowUs,
  })) {
    const { start, end } = window
    const status =
      !Number.isFinite(start) || !Number.isFinite(end) || end <= start
        ? 'missing-window'
        : !profile
          ? 'no-profile'
          : !valid
            ? 'invalid-profile'
            : profile.startTime > start || profile.endTime < end
              ? 'stale-profile'
              : 'available'
    const costs = new Map()
    let samples = 0
    let repoSamples = 0
    let unmappedCalls = 0
    const cost = loc => {
      const key = `${loc.source}:${loc.line}:${loc.column}`
      if (!costs.has(key))
        costs.set(key, {
          ...loc,
          samples: 0,
          sampledSelfMs: 0,
          sampledInclusiveMs: 0,
          calls: 0,
          callWallMs: 0,
          callThreadMs: 0,
          callsWithoutThreadTime: 0,
        })
      return costs.get(key)
    }
    if (status === 'available') {
      let clock = profile.startTime
      for (const [index, id] of profile.samples.entries()) {
        const next = clock + profile.timeDeltas[index]
        const duration = Math.max(0, Math.min(next, end) - Math.max(clock, start))
        clock = next
        if (!duration) continue
        samples++
        let cursor = id
        const visited = new Set()
        const locations = new Set()
        while (cursor !== undefined && !visited.has(cursor)) {
          visited.add(cursor)
          const loc = location(nodes.get(cursor)?.callFrame)
          if (loc) {
            const row = cost(loc)
            const key = `${loc.source}:${loc.line}:${loc.column}`
            if (!locations.has(key)) row.sampledInclusiveMs += duration / 1000
            locations.add(key)
            if (cursor === id) {
              row.samples++
              row.sampledSelfMs += duration / 1000
              repoSamples++
            }
          }
          cursor = parents.get(cursor)
        }
      }
    }
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      for (const event of trace.traceEvents) {
        if (
          !rendererPids.includes(event.pid) ||
          event.ph !== 'X' ||
          event.name !== 'FunctionCall' ||
          !Number.isFinite(event.ts) ||
          !Number.isFinite(event.dur) ||
          event.dur < 0 ||
          event.ts < start ||
          event.ts + event.dur > end
        )
          continue
        const data = event.args?.data
        const loc = location({
          scriptId: data?.scriptId,
          lineNumber: data?.lineNumber - 1,
          columnNumber: data?.columnNumber - 1,
        })
        if (!loc) {
          unmappedCalls++
          continue
        }
        const row = cost(loc)
        row.calls++
        row.callWallMs += event.dur / 1000
        if (Number.isFinite(event.tdur)) row.callThreadMs += event.tdur / 1000
        else row.callsWithoutThreadTime++
      }
    }
    phases[phase] = {
      status,
      samples,
      repoSamples,
      unmappedSamples: samples - repoSamples,
      unmappedCalls,
      functions: [...costs.values()].sort((a, b) => b.sampledSelfMs - a.sampledSelfMs).slice(0, 40),
    }
  }
  return phases
}

/** Consume the existing stop/export seam; no recorder is started or extended here. */
export async function stopRendererThreadTiming(
  client,
  directory,
  target,
  outputPath,
  rendererPids,
  idleCpuWindow,
  repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url))),
  applicationUrl
) {
  const state = JSON.parse(await readFile(join(directory, `performance-${target}.json`), 'utf8'))
  assert.equal(state.target, target, 'The recording belongs to another renderer')
  const metadata = [...(state.metadata ?? [])]
  let profile
  let maps = new Map()
  let sourceMapsUnavailable = 0
  let protocolLostEvents = state.lostEvents ?? 0
  let debuggerEnabled = false
  let mappingDeadline
  const recordingClient = async input => {
    const result = await client(input)
    if (input.method === 'Profiler.stop') profile = result.profile
    if (input.method === 'Tracing.end' && Array.isArray(profile?.nodes)) {
      mappingDeadline = performance.now() + 4000
      try {
        debuggerEnabled = true
        await withTimeout(
          client({ action: 'command', target, method: 'Debugger.enable' }),
          Math.max(1, mappingDeadline - performance.now()),
          'Renderer source map metadata unavailable'
        )
      } catch {
        sourceMapsUnavailable++
      }
    }
    if (input.action === 'events') {
      protocolLostEvents += result.lost ?? 0
      metadata.push(
        ...result.events.filter(event =>
          ['Debugger.scriptParsed', 'Runtime.executionContextCreated'].includes(event.method)
        )
      )
    }
    if (input.method === 'IO.close' && Array.isArray(profile?.nodes)) {
      const loaded = await rendererFunctionMaps(
        client,
        target,
        profile,
        metadata,
        await realpath(repositoryRoot),
        mappingDeadline,
        applicationUrl
      )
      maps = loaded.maps
      sourceMapsUnavailable += loaded.unavailable
    }
    return result
  }
  try {
    return await stopPerformanceRecording(
      recordingClient,
      directory,
      target,
      outputPath,
      trace => ({
        ...formatRendererThreadTiming(trace, rendererPids),
        idleCpuWindow: idleCpuWindow ?? null,
        functions: summarizeRendererFunctions(trace, rendererPids, profile, maps),
        evidence: {
          protocolLostEvents,
          metadataLostEvents: state.metadataLostEvents ?? 0,
          sourceMapsUnavailable,
        },
        notes: [
          'Function identities are repository locations. Samples are not invocation counts.',
          'Sampled and nested call costs must not be summed; missing thread time is reported separately.',
          'Capture is diagnostic and cannot establish a passing performance budget.',
        ],
      })
    )
  } finally {
    profile = undefined
    if (debuggerEnabled)
      await withTimeout(
        client({ action: 'command', target, method: 'Debugger.disable' }),
        1000,
        'Renderer debugger cleanup unavailable'
      ).catch(() => {})
  }
}

export function installTurnUpdateProbe() {
  const listeners = (window.__WEWORK_E2E_RUNTIME_EVENT_LISTENERS__ ??= new Set())
  const updates = []
  // Observe the whole browser task, including React work in its microtasks.
  const longTasks = []
  const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries()))
  observer.observe({ type: 'longtask' })
  const longFrames = []
  const frameObserver = PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')
    ? new PerformanceObserver(list => longFrames.push(...list.getEntries()))
    : null
  frameObserver?.observe({ type: 'long-animation-frame' })
  const settled = new Set()
  let onSettled
  const listener = ({ event, payload }) => {
    const status = payload.data?.status
    if (event !== 'runtime.turn.updated' || !payload.data?.task) return
    if (status !== 'started' && status !== 'settled') return
    const update = { taskId: payload.taskId, status, observedAt: performance.now() }
    updates.push(update)
    // The observer runs before the application handlers. Record the first
    // microtask checkpoint after this event, within the same browser task.
    queueMicrotask(() => {
      update.afterDeliveryAt = performance.now()
    })
    performance.mark?.(`wework-profile:turn-${status}`)
    if (status === 'settled') {
      settled.add(payload.taskId)
      onSettled?.(payload.taskId)
    }
  }
  listeners.add(listener)
  window.__weworkProfileTurnUpdates = {
    waitForSettled(taskId, timeoutMs) {
      if (settled.has(taskId)) return true
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          onSettled = undefined
          resolve(false)
        }, timeoutMs)
        onSettled = settledTaskId => {
          if (settledTaskId !== taskId) return
          clearTimeout(timer)
          onSettled = undefined
          resolve(true)
        }
      })
    },
    stop(taskId) {
      listeners.delete(listener)
      longTasks.push(...observer.takeRecords())
      observer.disconnect()
      if (frameObserver) {
        longFrames.push(...frameObserver.takeRecords())
        frameObserver.disconnect()
      }
      delete window.__weworkProfileTurnUpdates
      let index = 0
      return updates
        .filter(update => update.taskId === taskId)
        .map(({ status, observedAt, afterDeliveryAt }) => {
          while (
            longTasks[index] &&
            longTasks[index].startTime + longTasks[index].duration <= observedAt
          ) {
            index++
          }
          const task = longTasks[index]
          const longTask = task && task.startTime <= observedAt ? task : null
          const frame = longFrames.find(
            entry => entry.startTime <= observedAt && observedAt < entry.startTime + entry.duration
          )
          return {
            status,
            observedAt,
            longTaskMs: longTask?.duration ?? 0,
            ...(longTask && {
              longTaskStartMs: longTask.startTime,
              afterDeliveryAt,
            }),
            ...(frame && {
              frame: {
                durationMs: frame.duration,
                scripts: frame.scripts
                  .map(script => ({
                    source: script.sourceURL,
                    functionName: script.sourceFunctionName,
                    position: script.sourceCharPosition,
                    durationMs: script.duration,
                    forcedLayoutMs: script.forcedStyleAndLayoutDuration,
                  }))
                  .sort((left, right) => right.durationMs - left.durationMs)
                  .slice(0, 5),
              },
            }),
          }
        })
    },
  }
}

async function rendererPids(control) {
  const { processes } = JSON.parse(await control.command('getOwnedProcessSnapshot', 'body'))
  const pids = processes
    .filter(process => process.source === 'electron' && process.kind === 'window')
    .map(process => process.pid)
  assert.ok(pids.length > 0, 'No isolated renderer process was found')
  return pids
}

async function cpuSnapshot(pids) {
  const { stdout } = await run('ps', ['-p', pids.join(','), '-o', 'time=,utime=,stime='])
  const rows = stdout
    .trim()
    .split('\n')
    .map(row => row.trim().split(/\s+/))
  assert.equal(rows.length, pids.length, 'A measured renderer exited')
  assert.ok(
    rows.every(row => row.length === 3 && row.every(value => /^\d+(?::\d+)+\.\d+$/.test(value))),
    'Invalid macOS CPU counters'
  )
  const totals = [0, 0, 0]
  for (const row of rows) {
    row.forEach((value, index) => {
      totals[index] += value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)
    })
  }
  const [seconds, userSeconds, systemSeconds] = totals
  return { seconds, userSeconds, systemSeconds, time: performance.now() }
}

function cpuPercent(before, after) {
  return ((after.seconds - before.seconds) * 100_000) / (after.time - before.time)
}

export function peakTenSecondCpu(samples) {
  let peak
  let end = 1
  for (const start of samples) {
    while (end < samples.length && samples[end].time - start.time < 10_000) end++
    if (end === samples.length) break
    peak = Math.max(peak ?? 0, cpuPercent(start, samples[end]))
  }
  assert.notEqual(peak, undefined, 'Concurrent phase did not yield a ten-second CPU window')
  return peak
}

async function observeText(client, target, text, timeoutMs) {
  const result = await client({
    action: 'command',
    target,
    method: 'Runtime.evaluate',
    params: {
      expression: `(${function waitForText(selector, expected, timeout) {
        return new Promise(resolve => {
          const check = () => {
            const messages = document.querySelectorAll(selector)
            if ([...messages].some(message => message.textContent?.includes(expected))) finish(true)
          }
          const finish = matched => {
            observer.disconnect()
            clearTimeout(timer)
            resolve(matched)
          }
          const observer = new MutationObserver(check)
          observer.observe(document.body, { childList: true, characterData: true, subtree: true })
          const timer = setTimeout(() => finish(false), timeout)
          check()
        })
      }})(${JSON.stringify(pane + ' [data-testid="message-assistant"]')}, ${JSON.stringify(text)}, ${timeoutMs})`,
      awaitPromise: true,
      returnByValue: true,
    },
  })
  assert.equal(result.result?.value, true, `Timed out waiting for the assistant text ${text}`)
}

async function emitStream(response, id, { pieces = streamPieces, beforeCompletion } = {}) {
  const { itemId, start } = streamingEvents(id)
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
  let text = prefix
  response.write(sse([...start, ...textDeltaEvents(itemId, text)]))
  for (let i = 0; i < pieces; i++) {
    await delay(streamIntervalMs)
    const delta =
      i === pieces - 1
        ? '\n\n' + suffix
        : i % 5 === 0
          ? '\n\n- Streaming item ' + i
          : ' streamed words'
    response.write(sse(textDeltaEvents(itemId, delta, text.length)))
    text += delta
  }
  if (beforeCompletion) await beforeCompletion
  response.end(sse(streamingEvents(id, text).finish))
}

async function emitReasoning(response, id, pieces, onPiece) {
  const delta = ' Verify the workspace state and compare the previous command output.'
  const [item, part, ...events] = reasoningEvents(
    `${id}-reasoning`,
    delta.repeat(pieces),
    delta.length
  )
  const completed = events.pop()
  const summary = events.pop()
  response.write(sse([item, part]))
  for (const [index, event] of events.entries()) {
    await delay(streamIntervalMs)
    if (response.destroyed) return
    response.write(sse([event]))
    onPiece?.(index)
  }
  response.write(sse([summary, completed]))
  return completed.item
}

function profileCommand(index) {
  const first = (index % 25) + 1
  return [
    `printf "%s\\n" "Inspect workspace files for conversation step ${index + 1}"`,
    'git status --short -- README.md "README file.md" auth.ts',
    `sed -n '${first},${first + 8}p' README.md`,
    `sed -n '${first},${first + 12}p' "README file.md"`,
    'rg -n -i --max-count 5 "workspace|profile|fixture|task|runtime|conversation|configuration" README.md "README file.md" auth.ts || true',
    'git diff --stat -- README.md "README file.md" auth.ts',
    'git log -1 --format="%h %s" -- README.md "README file.md" auth.ts',
    'wc -l README.md "README file.md" auth.ts',
  ].join('\n')
}

async function measureConcurrentTasks({
  control,
  workspacePath,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  observeForegroundText,
  mark,
  windowState,
  pids,
  concurrentResponses,
  getForegroundToolsSent,
  startConcurrent,
  finishConcurrent,
  streamMilestones,
}) {
  const origin = await control.command('getLocationOrigin', 'body')
  const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs, { origin })
  const catalog = await rpc('runtime.runner.catalog', {})
  const model = catalog.models.find(entry => entry.runtime === 'codex' && entry.is_default)
  assert.ok(model, 'The concurrent profile requires the isolated Codex model')
  const { projectId, issues, pendingIssueSelector } = await preparePendingIssues(
    control,
    rpc,
    uiTimeoutMs
  )
  await rpc('runtime.settings.update', { maxConcurrentTasks: concurrentTaskCount })
  const taskIds = []
  let deviceId
  for (let i = 1; i <= concurrentTaskCount; i++) {
    const index = String(i).padStart(2, '0')
    const prompt = concurrentPrompt + index
    const taskId = 'renderer-profile-' + index
    taskIds.push(taskId)
    finishConcurrent.set(index, Promise.withResolvers())
    const result = await rpc('runtime.tasks.create', {
      taskId,
      title: prompt,
      workspacePath,
      runtime: 'codex',
      message: prompt,
      executionRequest: {
        task_id: taskId,
        subtask_id: taskId + '-first-turn',
        user_id: 9001,
        prompt,
        new_session: true,
        origin: {
          type: 'board_task',
          projectStore: 'local',
          cloudProjectId: projectId,
          loopItemId: issues[i - 1],
        },
        bot: [{ shell_type: 'Codex', name: 'Renderer profile' }],
        model_config: {
          model_id: model.local_model_id,
          model_provider: model.provider,
          runtime_config: { codex: { use_user_config: true, configured: true } },
        },
      },
    })
    assert.equal(result.accepted, true, `The executor did not admit ${taskId}`)
    deviceId ??= result.deviceId
  }
  for (let offset = 0; offset < foregroundToolCalls; offset += foregroundToolBatch) {
    const sent = Math.min(offset + foregroundToolBatch, foregroundToolCalls)
    await waitForValue(
      getForegroundToolsSent,
      count => count >= sent,
      `Foreground task did not emit history batch ending at tool call ${sent}`,
      offset === 0 ? modelResponseTimeoutMs : uiTimeoutMs
    )
  }
  await waitForValue(
    async () => [...concurrentResponses.keys()],
    indices => indices.length === concurrentTaskCount,
    'All ten tasks must reach the model server before the measurement',
    modelResponseTimeoutMs
  )
  const capacity = (await rpc('runtime.capacity.get', {})).categories.personal
  assert.ok(taskIds.every(taskId => capacity.active_task_ids.includes(taskId)))
  const taskId = taskIds[0]
  assert.ok(deviceId, 'The executor did not return a device for the concurrent tasks')
  await control.command('navigate', 'body', {
    value: '/runtime-tasks?' + new URLSearchParams({ deviceId, taskId }),
  })
  await waitForWorkbenchDebugState(
    control,
    state => state.taskId === taskId && state.isBusy,
    'The foreground conversation did not show the running profile task',
    uiTimeoutMs,
    'pane-activity'
  )
  assert.ok([...concurrentResponses.values()].every(response => !response.destroyed))
  const foregroundBefore = await windowState()
  await mark('concurrent-conversation-start')
  const foregroundSamples = [await cpuSnapshot(pids)]
  startConcurrent.resolve()
  try {
    const goal = await rpc('runtime.tasks.goal.set', {
      taskId,
      objective: 'Measure Goal updates while multiple tasks are streaming',
      status: 'active',
    })
    assert.equal(goal.goal?.status, 'active', goal.error)
    await waitForWorkbenchDebugState(
      control,
      state => state.pane?.goal?.status === 'active',
      'The foreground conversation did not receive the native Goal update',
      uiTimeoutMs
    )
  } finally {
    const cleared = await rpc('runtime.tasks.goal.clear', { taskId })
    assert.equal(cleared.success, true, cleared.error)
  }
  for (const piece of foregroundCpuSamplePieces) {
    assert.ok(await streamMilestones.get(piece).promise, `Foreground stream missed piece ${piece}`)
    foregroundSamples.push(await cpuSnapshot(pids))
  }
  await observeForegroundText('Streaming item 45')
  const foregroundEnd = await cpuSnapshot(pids)
  foregroundSamples.push(foregroundEnd)
  const foregroundAfter = await windowState()
  await mark('concurrent-conversation-end')
  await control.command(
    'clickWhenEnabled',
    '[data-testid="workspace-tab-select-pending-interactions"]'
  )
  await control.command('waitFor', pendingIssueSelector, { timeoutMs: uiTimeoutMs })
  assert.ok(
    [...concurrentResponses.values()].every(response => !response.writableEnded),
    'All ten streams must still be running when the pending Issues measurement starts'
  )
  await mark('concurrent-pending-start')
  const pendingSamples = [await cpuSnapshot(pids)]
  const pendingActions = [...pendingGoalUpdatePieces, ...pendingScrollPieces].sort((a, b) => a - b)
  for (const piece of pendingActions) {
    assert.ok(await streamMilestones.get(piece).promise, `Concurrent stream missed piece ${piece}`)
    const scrollIndex = pendingScrollPieces.indexOf(piece)
    if (scrollIndex !== -1) {
      await control.command(
        'scrollToRatioAsUser',
        '[data-testid="runtime-interactions-page"] .interaction-queue .overflow-y-auto',
        { value: scrollIndex % 2 === 0 ? '0.8' : '0.2', timeoutMs: uiTimeoutMs }
      )
      pendingSamples.push(await cpuSnapshot(pids))
      continue
    }
    const index = pendingGoalUpdatePieces.indexOf(piece)
    const taskId = taskIds[index + 1]
    const goal = await rpc('runtime.tasks.goal.set', {
      taskId,
      objective: 'Measure background task status changes in Pending Issues',
      status: 'active',
    })
    assert.equal(goal.goal?.status, 'active', goal.error)
    const cleared = await rpc('runtime.tasks.goal.clear', { taskId })
    assert.equal(cleared.success, true, cleared.error)
  }
  await Promise.all([...finishConcurrent.values()].map(entry => entry.promise))
  await waitForValue(
    async () => (await rpc('runtime.capacity.get', {})).categories.personal.active_task_ids,
    activeTaskIds => taskIds.every(id => !activeTaskIds.includes(id)),
    'All ten measured tasks must release their executor slots',
    uiTimeoutMs
  )
  const pendingEnd = await cpuSnapshot(pids)
  pendingSamples.push(pendingEnd)
  await mark('concurrent-pending-end')
  return {
    concurrentCpuPercent: {
      foregroundConversation: cpuPercent(foregroundSamples[0], foregroundEnd),
      foregroundPeakTenSecondCpu: peakTenSecondCpu(foregroundSamples),
      pendingIssues: cpuPercent(pendingSamples[0], pendingEnd),
      pendingPeakTenSecondCpu: peakTenSecondCpu(pendingSamples),
    },
    foregroundWindow: { before: foregroundBefore, after: foregroundAfter },
  }
}

async function preparePendingIssues(control, rpc, timeoutMs) {
  const profileResponse = await fetch(new URL('/api/users/me', control.url))
  assert.ok(profileResponse.ok)
  const { id: userId } = await profileResponse.json()
  assert.ok(Number.isInteger(userId) && userId > 0)
  const project = await rpc('projects.create', { name: 'Renderer profile project' })
  const issues = []
  for (let offset = 0; offset < projectIssueCount; offset += 8) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(8, projectIssueCount - offset) }, async (_, index) => {
        const position = offset + index
        const open = position < concurrentTaskCount || position >= projectIssueCount - 10
        const issue = await rpc('todos.create', {
          project_id: project.id,
          todo: {
            title: `Renderer profile issue ${position + 1}`,
            assignee_user_id: userId,
            status: open ? 'inbox' : 'completed',
          },
        })
        assert.equal(issue.status, open ? 'inbox' : 'completed')
        return issue.id
      })
    )
    issues.push(...batch)
  }
  await control.command(
    'clickWhenEnabled',
    '[data-testid="workspace-tab-select-pending-interactions"]'
  )
  const page = '[data-testid="runtime-interactions-page"]'
  await control.command('clickWhenEnabled', `${page} [data-testid="interactions-refresh"]`)
  const issueSelector = issueId => {
    const id = `project-issue:local:${project.id}:${issueId}`
    return `${page} [data-testid="interaction-list-item"][data-interaction-id=${JSON.stringify(id)}]`
  }
  const pendingIssueSelector = issueSelector(issues.at(-1))
  await control.command('waitFor', pendingIssueSelector, { timeoutMs })
  await control.command('clickWhenEnabled', '[data-testid="workspace-tab-select-fixed-task"]')
  return { projectId: project.id, issues, pendingIssueSelector }
}

export function createDesktopScenario({
  uiTimeoutMs,
  modelResponseTimeoutMs,
  resultDir,
  workspacePath,
  executorHome,
}) {
  const capture = process.env.WEWORK_RENDERER_PROFILE_CAPTURE === 'true'
  const threadTiming = process.env.WEWORK_RENDERER_PROFILE_THREAD_TIMING === 'true'
  const enforceBudgets = process.env.WEWORK_RENDERER_PROFILE_CHECK === 'true'
  const measureProcesses = capture || process.env.WEWORK_RENDERER_PROFILE_PROCESSES === 'true'
  const measureHistory = process.env.WEWORK_RENDERER_PROFILE_HISTORY === 'true'
  const samples = []
  const processSamples = []
  let historyIndex = 0
  let ready = false
  let started = false
  let finished = false
  let start
  let pids
  let readSingleTaskRendererMetrics
  let singleTaskStartMetrics
  let markSingleTask
  const singleModelRequest = Promise.withResolvers()
  const singleStreamCompletion = Promise.withResolvers()
  const concurrentResponses = new Map()
  const startConcurrent = Promise.withResolvers()
  const finishConcurrent = new Map()
  const streaming = new Set()
  const streamMilestones = new Map(
    [
      ...new Set([
        ...foregroundCpuSamplePieces,
        ...pendingGoalUpdatePieces,
        ...pendingScrollPieces,
        ...measuredToolPieces,
      ]),
    ].map(piece => [piece, Promise.withResolvers()])
  )
  let foregroundToolsSent = 0
  let reasoningDeltasSent = 0
  const countReasoningDelta = () => reasoningDeltasSent++
  const measuredBatches = new Map()
  return {
    async prepareApp() {
      const runtimeWork = join(executorHome, 'runtime-work')
      await mkdir(runtimeWork, { recursive: true })
      const tasks = Object.fromEntries(
        Array.from({ length: persistedTaskCount }, (_, index) => {
          const id = `renderer-profile-saved-${index}`
          return [
            id,
            {
              local_task_id: id,
              title: `Saved workbench task ${index + 1}`,
              workspace_path: workspacePath,
              runtime: 'codex',
              archived: false,
            },
          ]
        })
      )
      await writeFile(join(runtimeWork, 'index.json'), JSON.stringify({ version: 1, tasks }), {
        flag: 'wx',
        mode: 0o600,
      })
    },
    cleanup() {
      startConcurrent.resolve()
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname))
        return false
      const body = await readRawRequestBody(request)
      if (!ready && !historyIndex && !body.includes(warmupPrompt)) return false
      const modelRequest = JSON.parse(body)
      if (handleModelMaintenanceRequest(modelRequest, response)) return true
      if (body.includes(warmupPrompt)) {
        const id = 'wework-profile-warmup'
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([responseCreated(id), assistantMessage(warmupText), responseCompleted(id)])
        )
        return true
      }
      const index =
        body.match(new RegExp(`${concurrentPrompt}(\\d{2})`))?.[1] ??
        body.match(/renderer-profile-command-(\d{2})-/)?.[1]
      if (index && finishConcurrent.has(index) && !streaming.has(index)) {
        const batches = measuredBatches.get(index) ?? 0
        const foregroundTools = index === '01' && foregroundToolsSent < foregroundToolCalls
        if (!foregroundTools) {
          concurrentResponses.set(index, response)
          await startConcurrent.promise
        }
        const measuredTools = measuredToolTasks.has(index) && batches < measuredToolPieces.length
        if (
          !foregroundTools &&
          measuredTools &&
          (!(await streamMilestones.get(measuredToolPieces[batches]).promise) || response.destroyed)
        )
          return true
        if (foregroundTools || measuredTools) {
          const offset = foregroundTools
            ? foregroundToolsSent
            : foregroundToolCalls + batches * measuredToolBatch
          const count = foregroundTools
            ? Math.min(foregroundToolBatch, foregroundToolCalls - offset)
            : measuredToolBatch
          if (foregroundTools) foregroundToolsSent += count
          else measuredBatches.set(index, batches + 1)
          const id = `wework-benchmark-tool-history-${index}-${offset}`
          const hasReasoning = !foregroundTools && measuredReasoningTasks.has(index)
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
          response.write(sse([responseCreated(id)]))
          const reasoning = hasReasoning
            ? await emitReasoning(response, id, measuredReasoningPieces, countReasoningDelta)
            : undefined
          if (response.destroyed) return true
          const events = Array.from({ length: count }, (_, toolIndex) =>
            shellCommandResponse(
              modelRequest,
              `renderer-profile-command-${index}-${offset + toolIndex}`,
              profileCommand(offset + toolIndex),
              workspacePath
            )
          ).flatMap((events, index) =>
            events.map(event => ({ ...event, output_index: index + Number(hasReasoning) }))
          )
          const output = events.filter(event => event.type === 'response.output_item.done')
          response.end(
            sse([
              ...events,
              responseCompleted(id, [
                ...(reasoning ? [reasoning] : []),
                ...output.map(event => event.item),
              ]),
            ])
          )
          return true
        }
        streaming.add(index)
        try {
          if (!response.destroyed && index === concurrentClockTask) {
            const id = `wework-benchmark-${index}`
            response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
            response.write(sse([responseCreated(id)]))
            const reasoning = await emitReasoning(response, id, concurrentStreamPieces, piece => {
              countReasoningDelta()
              streamMilestones.get(piece)?.resolve(true)
            })
            if (!response.destroyed) {
              const reply = { ...assistantMessage(suffix, 'final_answer'), output_index: 1 }
              response.end(sse([reply, responseCompleted(id, [reasoning, reply.item])]))
            }
          } else if (!response.destroyed)
            await emitStream(response, `wework-benchmark-${index}`, {
              pieces: batches
                ? concurrentStreamPieces - measuredToolPieces.at(-1)
                : concurrentStreamPieces,
            })
        } finally {
          if (index === concurrentClockTask) {
            for (const milestone of streamMilestones.values()) milestone.resolve(false)
          }
          finishConcurrent.get(index).resolve()
        }
        return true
      }
      if (!ready && body.includes(historyPrompt + historyIndex)) {
        const id = 'wework-profile-history-' + historyIndex
        const content = Array.from(
          { length: 72 },
          (_, index) =>
            `### Record ${index + 1}\n\nSaved result for task ${historyIndex}. This paragraph represents a persisted assistant turn.\n`
        ).join('\n')
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(id),
            assistantMessage(`${content}\n${id}`, 'final_answer'),
            responseCompleted(id),
          ])
        )
        return true
      }
      if (!ready || !body.includes(prompt)) return false
      if (started) return false
      started = true
      singleModelRequest.resolve()
      if (markSingleTask) await markSingleTask('single-task-start')
      singleTaskStartMetrics = await readSingleTaskRendererMetrics?.()
      start = await cpuSnapshot(pids)
      await emitStream(response, 'wework-benchmark-response', {
        beforeCompletion: singleStreamCompletion.promise,
      })
      finished = true
      return true
    },
    async verify(control) {
      const sidebar = '[data-testid="desktop-sidebar"]'
      await control.command('waitFor', sidebar, { timeoutMs: uiTimeoutMs })
      if ((await control.command('getAttribute', sidebar, { value: 'aria-hidden' })) === 'true') {
        await control.command('clickWhenEnabled', '[data-testid="expand-sidebar-button"]', {
          visible: true,
          timeoutMs: uiTimeoutMs,
        })
      }
      await control.command('clickWhenEnabled', '[data-testid="new-chat-button"]', {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', composer, { visible: true, timeoutMs: uiTimeoutMs })
      await control.command('ensureLocalModelCatalogReady', 'body', { timeoutMs: uiTimeoutMs })
      const provider = await control.command(
        'getAttribute',
        pane + ' [data-testid="model-selector-button"]',
        {
          value: 'data-model-provider-id',
        }
      )
      assert.equal(provider, 'wework-e2e', 'The selected model must use the isolated model service')
      await waitForClosedStartupSplash(control, uiTimeoutMs)
      pids = await rendererPids(control)
      const inventory = await requestExecutor(control, 'runtime.tasks.list', {}, uiTimeoutMs)
      const savedTaskCount = inventory.workspaces
        .flatMap(workspace => workspace.tasks)
        .filter(task => task.taskId.startsWith('renderer-profile-saved-')).length
      assert.equal(savedTaskCount, persistedTaskCount, 'The profile must load the saved tasks')
      const textTimeoutMs = uiTimeoutMs + concurrentStreamPieces * streamIntervalMs
      const client = await createDevtoolsClient(resultDir, textTimeoutMs + 5000)
      const targets = await client({ action: 'targets' })
      const target = targets.find(
        entry =>
          entry.type === 'window' &&
          !entry.url.startsWith('devtools:') &&
          !entry.url.includes('startup-splash')
      )?.id
      assert.ok(target, 'The isolated main renderer was not found')
      const evaluate = async expression => {
        const { result, exceptionDetails } = await client({
          action: 'command',
          target,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        })
        assert.ok(!exceptionDetails, result.description ?? 'Renderer evaluation failed')
        return result.value
      }
      const mark = phase =>
        capture && evaluate(`performance.mark(${JSON.stringify(`wework-profile:${phase}`)})`)
      const windowState = () =>
        evaluate(`(async () => ({
          activity: await window.weworkElectronLifecycle.getWorkbenchActivity(),
          visibility: document.visibilityState,
          focused: document.hasFocus(),
        }))()`)
      const sampleHeap = async phase => {
        const { usedSize } = await client({
          action: 'command',
          target,
          method: 'Runtime.getHeapUsage',
        })
        assert.ok(Number.isFinite(usedSize), 'The renderer did not report its used JS heap')
        samples.push({ phase, at: Date.now(), usedSize })
      }
      const reportPath = join(
        resultDir,
        threadTiming ? 'renderer-performance-timing.json' : 'renderer-performance.json'
      )
      let idleCpuWindow
      const finishRecording = () =>
        threadTiming
          ? stopRendererThreadTiming(
              client,
              resultDir,
              target,
              reportPath,
              pids,
              idleCpuWindow,
              undefined,
              targets.find(entry => entry.id === target)?.url
            )
          : stopPerformanceRecording(client, resultDir, target, reportPath)
      const sampleProcesses = async phase => {
        const snapshot = JSON.parse(await control.command('getOwnedProcessSnapshot', 'body'))
        processSamples.push({
          phase,
          at: snapshot.capturedAt,
          system: {
            availableParallelism: availableParallelism(),
            freeMemoryBytes: freemem(),
            loadAverage: loadavg(),
          },
          incomplete: Boolean(snapshot.collectingSystemProcesses),
          degradation: snapshot.degraded?.map(entry => entry.code) ?? [],
          processes: snapshot.processes.map(process => ({
            pid: process.pid,
            parentPid: process.parentPid,
            kind: process.kind,
            source: process.source,
            owner: process.owner?.key ?? null,
            cpuPercent: process.cpuPercent,
            memoryBytes: process.memoryBytes,
            idleWakeupsPerSecond: process.idleWakeupsPerSecond,
          })),
        })
      }
      let recording = false
      const command = (method, params) => client({ action: 'command', target, method, params })
      let probingTurnUpdates = false
      try {
        if (measureHistory) {
          const taskIds = new Set()
          while (taskIds.size < historyTaskCount) {
            historyIndex = taskIds.size + 1
            await control.command('fill', composer, { value: historyPrompt + historyIndex })
            await control.command('press', composer, { key: 'Enter' })
            await observeText(
              client,
              target,
              'wework-profile-history-' + historyIndex,
              textTimeoutMs
            )
            const snapshot = await waitForWorkbenchDebugState(
              control,
              ({ taskId, isBusy }) => taskId && !taskIds.has(taskId) && isBusy === false,
              `Historical task ${historyIndex} did not settle`,
              textTimeoutMs,
              'pane-activity'
            )
            taskIds.add(snapshot.taskId)
            await sampleHeap('history')
            await control.command('clickWhenEnabled', '[data-testid="new-chat-button"]', {
              visible: true,
              timeoutMs: uiTimeoutMs,
            })
            await control.command('waitFor', composer, { visible: true, timeoutMs: uiTimeoutMs })
          }
        }
        await control.command('fill', composer, { value: warmupPrompt })
        await control.command('press', composer, { key: 'Enter' })
        await observeText(client, target, warmupText, textTimeoutMs)
        await waitForWorkbenchDebugState(
          control,
          ({ isBusy }) => isBusy === false,
          'The renderer warmup turn did not settle',
          textTimeoutMs,
          'pane-activity'
        )
        await control.command('clickWhenEnabled', '[data-testid="new-chat-button"]', {
          visible: true,
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', composer, { visible: true, timeoutMs: uiTimeoutMs })
        const before = await windowState()
        assert.equal(before.activity, 'foreground', 'Measure the foreground presentation path')
        const running = await requestExecutor(
          control,
          'runtime.tasks.running_count',
          {},
          uiTimeoutMs
        )
        assert.equal(running.runningCount, 0, 'The idle profile requires zero running tasks')
        if (capture) {
          await startPerformanceRecording(client, resultDir, target, {
            samplingIntervalUs: threadTiming ? 2000 : 100,
          })
          recording = true
          if (threadTiming) markSingleTask = mark
        }
        await mark('idle-start')
        const idleStart = await cpuSnapshot(pids)
        for (let i = 0; i < idleSamples; i++) {
          await sampleHeap('idle')
          await delay(sampleIntervalMs)
        }
        const idleEnd = await cpuSnapshot(pids)
        idleCpuWindow = { start: idleStart, end: idleEnd }
        await mark('idle-end')
        if (measureProcesses) await sampleProcesses('idle')
        assert.ok(
          await evaluate("PerformanceObserver.supportedEntryTypes.includes('longtask')"),
          'The renderer does not support long-task timing'
        )
        await evaluate(`(${installTurnUpdateProbe.toString()})()`)
        probingTurnUpdates = true
        if (enforceBudgets) {
          await command('Performance.enable', { timeDomain: 'timeTicks' })
          const { metrics } = await command('Performance.getMetrics')
          const navigationStart = metrics.find(metric => metric.name === 'NavigationStart')?.value
          assert.ok(
            Number.isFinite(navigationStart),
            'The renderer did not report its navigation clock'
          )
          // The failure-only capture owns V8 profiling, which consumes renderer CPU.
          // Keep endpoint diagnostics outside the process CPU measurement window.
          readSingleTaskRendererMetrics = async () => {
            const system = { availableParallelism: availableParallelism(), loadAverage: loadavg() }
            try {
              const { metrics } = await withTimeout(
                command('Performance.getMetrics'),
                2000,
                'The renderer did not report single-task CPU diagnostics'
              )
              return {
                system,
                renderer: Object.fromEntries(metrics.map(({ name, value }) => [name, value])),
              }
            } catch {
              return { system, rendererMetricsUnavailable: true }
            }
          }
        }

        const controller = new AbortController()
        const collect = async () => {
          try {
            while (!controller.signal.aborted) {
              await delay(sampleIntervalMs, undefined, { signal: controller.signal })
              await sampleHeap('running')
              if (
                measureProcesses &&
                start &&
                performance.now() - start.time >= 6000 &&
                processSamples.length === 1
              )
                await sampleProcesses('running')
            }
          } catch (error) {
            if (error.name !== 'AbortError') throw error
          }
        }
        const interact = async () => {
          try {
            ready = true
            await control.command('fill', composer, { value: prompt })
            await control.command('press', composer, { key: 'Enter' })
            await withTimeout(
              singleModelRequest.promise,
              modelResponseTimeoutMs,
              'The single-task renderer profile did not reach the isolated model service'
            )
            await observeText(client, target, prefix, uiTimeoutMs)
            assert.ok(!finished, 'The first response text must appear while streaming')
            await observeText(client, target, suffix, textTimeoutMs)
            // Keep terminal processing outside the streaming CPU window. The
            // turn-update probe stays active through the subsequent settlement.
            const end = await cpuSnapshot(pids)
            controller.abort()
            if (markSingleTask) await markSingleTask('single-task-end')
            const endMetrics = await readSingleTaskRendererMetrics?.()
            return { end, endMetrics }
          } finally {
            singleStreamCompletion.resolve()
            controller.abort()
          }
        }
        const [interaction, sampling] = await Promise.allSettled([interact(), collect()])
        if (interaction.status === 'rejected') throw interaction.reason
        if (sampling.status === 'rejected') throw sampling.reason
        const { end, endMetrics } = interaction.value
        assert.ok(start, 'The isolated model stream did not start')
        await waitForBottom(control, 'The streamed conversation', uiTimeoutMs)
        const { taskId } = await waitForWorkbenchDebugState(
          control,
          ({ taskId, isBusy }) => taskId && isBusy === false,
          'The profiled turn did not settle in the workbench',
          uiTimeoutMs,
          'pane-activity'
        )
        assert.ok(
          await evaluate(
            `window.__weworkProfileTurnUpdates.waitForSettled(${JSON.stringify(taskId)}, ${uiTimeoutMs})`
          ),
          'The profiled task did not receive a settled runtime.turn.updated snapshot'
        )
        const turnUpdates = await evaluate(
          `window.__weworkProfileTurnUpdates.stop(${JSON.stringify(taskId)})`
        )
        probingTurnUpdates = false
        if (enforceBudgets) await command('Performance.disable')
        assert.ok(
          turnUpdates.some(update => update.status === 'started'),
          'The profiled task did not receive a started runtime.turn.updated snapshot'
        )
        await sampleHeap('settled')
        if (measureProcesses) await sampleProcesses('settled')
        const { concurrentCpuPercent, foregroundWindow } = await measureConcurrentTasks({
          control,
          workspacePath,
          uiTimeoutMs,
          modelResponseTimeoutMs,
          observeForegroundText: text => observeText(client, target, text, textTimeoutMs),
          mark,
          windowState,
          pids,
          concurrentResponses,
          getForegroundToolsSent: () => foregroundToolsSent,
          startConcurrent,
          finishConcurrent,
          streamMilestones,
        })
        await sampleHeap('ten-tasks')
        const measuredToolsSent = [...measuredBatches.values()].reduce(
          (sum, count) => sum + count * measuredToolBatch,
          0
        )
        assert.equal(
          measuredToolsSent,
          measuredToolTasks.size * measuredToolPieces.length * measuredToolBatch
        )
        assert.equal(
          reasoningDeltasSent,
          concurrentStreamPieces +
            measuredReasoningTasks.size * measuredToolPieces.length * measuredReasoningPieces
        )
        const measurements = {
          idleCpuPercent: cpuPercent(idleStart, idleEnd),
          singleTaskCpuPercent: cpuPercent(start, end),
          tenTaskCpuPercent: Math.max(...Object.values(concurrentCpuPercent)),
          maxTurnUpdateLongTaskMs: Math.max(...turnUpdates.map(update => update.longTaskMs)),
          peakObservedJsHeapBytes: Math.max(...samples.map(sample => sample.usedSize)),
        }
        const after = await windowState()
        const validPresentation = [
          before,
          after,
          foregroundWindow.before,
          foregroundWindow.after,
        ].every(state => state.activity === 'foreground')
        const report = {
          measurements,
          idleCpuWindow,
          singleTaskWindow: {
            start: { ...start, ...singleTaskStartMetrics },
            end: { ...end, ...endMetrics },
          },
          concurrentCpuPercent,
          turnUpdates,
          heapSamples: samples,
          processSamples,
          historicalTasks: measureHistory ? historyTaskCount : 0,
          savedTaskCount,
          projectIssueCount,
          foregroundToolsSent,
          measuredToolsSent,
          reasoningDeltasSent,
          rendererPids: pids,
          window: { before, after, foregroundConversation: foregroundWindow },
          validPresentation,
          capture,
          limits,
          withinLimits: capture
            ? null
            : validPresentation &&
              Object.entries(limits).every(([metric, limit]) => measurements[metric] < limit),
        }
        await writeDiagnosticFile(join(resultDir, 'renderer-threshold-measurements.json'), report)
        console.log('[renderer-profile]', JSON.stringify(measurements))
        assert.ok(validPresentation, 'The presentation path changed during the run')
        if (recording) {
          recording = false
          await finishRecording()
        }
        if (enforceBudgets) {
          assert.ok(
            report.withinLimits,
            'Renderer exceeds a limit; see renderer-threshold-measurements.json'
          )
        }
      } finally {
        try {
          if (probingTurnUpdates) await evaluate('window.__weworkProfileTurnUpdates?.stop()')
        } finally {
          try {
            if (recording) await finishRecording()
          } finally {
            await client({ action: 'detach', target })
          }
        }
      }
    },
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log(
      'Usage: pnpm --filter wework profile:renderer [--capture [--thread-timing] | --check] [--history] [--processes] (macOS)'
    )
    return
  }
  assert.equal(process.platform, 'darwin', 'Renderer CPU counters require macOS')
  assert.ok(
    new Set(args).size === args.length &&
      args.every(arg =>
        ['--capture', '--check', '--thread-timing', '--history', '--processes'].includes(arg)
      ) &&
      !(args.includes('--capture') && args.includes('--check')) &&
      (!args.includes('--thread-timing') || args.includes('--capture')),
    'Use --capture or --check, with optional --history and --processes. --thread-timing requires --capture'
  )
  const contents = fileURLToPath(
    new URL(
      `../electron/release/WeWork-darwin-${process.arch}/WeWork.app/Contents/`,
      import.meta.url
    )
  )
  const app = process.env.WEWORK_E2E_APP_BIN ?? join(contents, 'MacOS', 'WeWork')
  const executor =
    process.env.WEWORK_E2E_EXECUTOR_BIN ?? join(contents, 'Resources/bin/wegent-executor')
  for (const path of [app, executor]) {
    await access(path).catch(error => {
      throw new Error(`Build the verification bundle or provide the binary: ${path}`, {
        cause: error,
      })
    })
  }
  const runner = fileURLToPath(new URL('../e2e/desktop/task-flow.e2e.mjs', import.meta.url))
  const child = spawn(process.execPath, [runner, '--segment', 'streaming-conversation-switching'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      WEWORK_E2E_APP_BIN: app,
      WEWORK_E2E_EXECUTOR_BIN: executor,
      WEWORK_E2E_DESKTOP_SCENARIO_ONLY: 'true',
      WEWORK_E2E_BACKGROUND_WINDOW: '1',
      WEWORK_E2E_DESKTOP_SCENARIO_MODULE: import.meta.url,
      WEWORK_RENDERER_PROFILE_CAPTURE: String(args.includes('--capture')),
      WEWORK_RENDERER_PROFILE_THREAD_TIMING: String(args.includes('--thread-timing')),
      WEWORK_RENDERER_PROFILE_CHECK: String(args.includes('--check')),
      WEWORK_RENDERER_PROFILE_HISTORY: String(args.includes('--history')),
      WEWORK_RENDERER_PROFILE_PROCESSES: String(args.includes('--processes')),
    },
  })
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main()
