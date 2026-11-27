import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { withTimeout } from '../e2e/desktop/modules/shared.mjs'

const run = promisify(execFile)

function safeFunctionName(value = '') {
  if (['(root)', '(idle)', '(program)', '(garbage collector)'].includes(value)) return value
  const name = value.split('(')[0].trim()
  return /^[A-Za-z_$][\w$.:~<> ]{0,159}$/.test(name) ? name : '(unresolved)'
}

function threadCategory(value) {
  if (/CpuProfiler|SamplingThread|SignalSender|V8 Profiler/.test(value)) return 'v8-profiler'
  if (/CrRendererMain/.test(value)) return 'renderer-main'
  if (/Compositor/.test(value)) return 'compositor'
  if (/Raster/.test(value)) return 'raster'
  if (/GC|GarbageCollector/.test(value)) return 'gc'
  return 'other'
}

// sample's call graph contains inclusive stack counts, not per-thread CPU time.
// Retain exclusive function counts only; headers, paths and register values stay local.
export function summarizeNativeSample(text) {
  const threads = []
  const stack = []
  let thread
  let inGraph = false
  const finish = () => {
    const node = stack.pop()
    const self = Math.max(0, node.samples - node.children)
    if (stack.length) stack.at(-1).children += node.samples
    if (self && node.function) {
      thread.functions.set(node.function, (thread.functions.get(node.function) ?? 0) + self)
    }
  }
  for (const line of text.split('\n')) {
    if (line.trim() === 'Call graph:') inGraph = true
    if (line.startsWith('Total number in stack') || line.startsWith('Binary Images:')) break
    if (!inGraph) continue
    const entry = line.match(/^[ +!:|]*(\d+)\s+(.+)$/)
    if (!entry) continue
    const samples = Number(entry[1])
    const depth = line.indexOf(entry[1])
    if (/^Thread_\w+\b/.test(entry[2])) {
      while (stack.length) finish()
      thread = { category: threadCategory(entry[2]), samples, functions: new Map() }
      threads.push(thread)
      stack.push({ depth, samples, children: 0 })
    } else if (thread) {
      while (stack.length && stack.at(-1).depth >= depth) finish()
      const functionName = safeFunctionName(entry[2])
      if (thread.category === 'other') thread.category = threadCategory(functionName)
      stack.push({ depth, samples, children: 0, function: functionName })
    }
  }
  while (stack.length) finish()
  return threads.map(({ category, samples, functions }) => ({
    category,
    samples,
    functions: [...functions]
      .map(([functionName, count]) => ({ function: functionName, samples: count }))
      .sort((left, right) => right.samples - left.samples)
      .slice(0, 20),
  }))
}

export function summarizeJavascriptProfile(profile) {
  const costs = new Map()
  for (const [index, id] of (profile.samples ?? []).entries()) {
    const cost = costs.get(id) ?? { samples: 0, selfUs: 0 }
    cost.samples++
    cost.selfUs += profile.timeDeltas?.[index] ?? 0
    costs.set(id, cost)
  }
  return {
    durationMs: (profile.endTime - profile.startTime) / 1000,
    functions: profile.nodes
      .flatMap(({ id, callFrame }) => {
        const cost = costs.get(id)
        return cost
          ? [
              {
                function: safeFunctionName(callFrame.functionName),
                line: callFrame.lineNumber + 1,
                column: callFrame.columnNumber + 1,
                samples: cost.samples,
                selfMs: cost.selfUs / 1000,
              },
            ]
          : []
      })
      .sort((left, right) => right.selfMs - left.selfMs)
      .slice(0, 30),
  }
}

async function sampleRenderer(pid, signal) {
  const { stdout } = await run(
    '/usr/bin/sample',
    [String(pid), '1', '10', '-mayDie', '-file', '/dev/stdout'],
    {
      signal,
      timeout: 1500,
      maxBuffer: 2 * 1024 * 1024,
    }
  )
  const threads = summarizeNativeSample(stdout)
  if (!threads.length) throw new Error('The native renderer sample has no call graph')
  return threads
}

// This probe is only invoked after the original budget verdict has been frozen.
// Neither diagnostic stream nor profiler samples participate in a budget measurement.
export async function captureRendererCpuFailure({
  pids,
  command,
  readCpuSnapshot,
  cpuPercent,
  startWork,
  stopWork,
  sample = sampleRenderer,
}) {
  const began = performance.now()
  // Reserve three bounded (500 ms) protocol cleanup calls within a six-second ceiling.
  const signal = AbortSignal.timeout(4500)
  const evidence = { phase: 'after-budget-failure', status: 'incomplete', windows: [] }
  const step = (operation, limit = 500) => {
    signal.throwIfAborted()
    const remaining = Math.max(1, 4500 - (performance.now() - began))
    return withTimeout(operation(), Math.min(limit, remaining), 'CPU diagnostic step timed out')
  }
  const request = (method, params) => step(() => command(method, params))
  let profiling = false
  try {
    await request('Performance.enable', { timeDomain: 'timeTicks' })
    const metrics = async () => {
      const { metrics } = await request('Performance.getMetrics')
      return Object.fromEntries(
        metrics
          .filter(({ name }) => ['ProcessTime', 'ThreadTime', 'Timestamp'].includes(name))
          .map(({ name, value }) => [name, value])
      )
    }
    for (const withProfiler of [false, true]) {
      signal.throwIfAborted()
      evidence.stage = withProfiler ? 'prepare-with-profiler' : 'prepare-without-profiler'
      // Both fresh conversations receive the same held fixture and exact stream pieces.
      const work = await step(() => startWork(signal), 2500)
      signal.throwIfAborted()
      if (withProfiler) {
        await request('Profiler.enable')
        await request('Profiler.setSamplingInterval', { interval: 2000 })
        signal.throwIfAborted()
        // A lost start response may still have enabled profiling; stop in cleanup.
        profiling = true
        await request('Profiler.start')
      }
      const before = await step(readCpuSnapshot)
      const beforeMetrics = await metrics()
      signal.throwIfAborted()
      evidence.stage = withProfiler ? 'sample-with-profiler' : 'sample-without-profiler'
      const native = Promise.all(
        pids.map(async pid => ({ pid, threads: await sample(pid, signal) }))
      )
      work.begin()
      const [threads, settled] = await Promise.allSettled([
        native,
        step(() => work.settled(), 2000),
      ])
      if (threads.status === 'rejected') throw threads.reason
      if (settled.status === 'rejected') throw settled.reason
      signal.throwIfAborted()
      const afterMetrics = await metrics()
      const after = await step(readCpuSnapshot)
      const seconds = afterMetrics.Timestamp - beforeMetrics.Timestamp
      if (
        ![
          seconds,
          beforeMetrics.ProcessTime,
          afterMetrics.ProcessTime,
          beforeMetrics.ThreadTime,
          afterMetrics.ThreadTime,
        ].every(Number.isFinite) ||
        seconds <= 0 ||
        after.time <= before.time ||
        after.seconds < before.seconds
      )
        throw new Error('Invalid post-failure CPU diagnostic counters')
      evidence.windows.push({
        withProfiler,
        durationMs: after.time - before.time,
        processCpuPercent: cpuPercent(before, after),
        cdpProcessCpuPercent:
          ((afterMetrics.ProcessTime - beforeMetrics.ProcessTime) * 100) / seconds,
        cdpMainThreadCpuPercent:
          ((afterMetrics.ThreadTime - beforeMetrics.ThreadTime) * 100) / seconds,
        before,
        after,
        beforeMetrics,
        afterMetrics,
        native: threads.value,
      })
      if (withProfiler) {
        const { profile } = await request('Profiler.stop')
        profiling = false
        evidence.javascript = summarizeJavascriptProfile(profile)
      }
      stopWork()
    }
    evidence.status = 'captured'
    evidence.stage = 'complete'
  } catch {
    // Optional evidence must never replace the already-failed performance assertion.
    evidence.status = signal.aborted ? 'timed-out' : 'unavailable'
  } finally {
    stopWork()
    if (profiling) await command('Profiler.stop').catch(() => {})
    await command('Profiler.disable').catch(() => {})
    await command('Performance.disable').catch(() => {})
    evidence.durationMs = performance.now() - began
  }
  return evidence
}
