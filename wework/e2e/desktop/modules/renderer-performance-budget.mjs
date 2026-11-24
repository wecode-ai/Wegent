import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createDevtoolsClient, writeDiagnosticFile } from '../../../scripts/ai-verify-devtools.mjs'

const MiB = 1024 ** 2
const PROBE = 'globalThis.__weworkE2ERendererPerformance'
const PHASES = ['away-ready', 'transcript-restored']
const CPU_METRICS = ['TaskDuration', 'RecalcStyleDuration', 'LayoutDuration']

export const RENDERER_PERFORMANCE_BUDGET = Object.freeze({
  clickToFrameMs: 200,
  switchReadyMs: 500,
  longestTaskMs: 100,
  longestFrameMs: 150,
  totalBlockingMs: 150,
  mainThreadMs: 350,
  styleAndLayoutMs: 120,
  observedJsHeapBytes: 512 * MiB,
  jsHeapGrowthBytes: 64 * MiB,
  observedDomNodes: 25_000,
  domNodeGrowth: 5_000,
  observedEventListeners: 25_000,
  eventListenerGrowth: 2_000,
})

export function assertRendererPerformanceBudget(metrics) {
  const violations = []
  for (const [name, limit] of Object.entries(RENDERER_PERFORMANCE_BUDGET)) {
    const value = metrics[name]
    if (!Number.isFinite(value) || value < 0) violations.push(`${name} is missing or invalid`)
    else if (value > limit) violations.push(`${name} ${value} exceeds ${limit}`)
  }
  assert.ok(violations.length === 0, violations.join(', '))
}

// Runs in the isolated Electron renderer. Keep only numeric timing evidence.
function installProbe() {
  if (document.visibilityState !== 'visible') throw new Error('Renderer is not visible')
  const entries = { longtask: [], 'long-animation-frame': [] }
  const observers = Object.entries(entries).map(([type, durations]) => {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) {
      throw new Error('Missing PerformanceObserver entry type ' + type)
    }
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) durations.push(entry.duration)
    })
    return { observer, type, durations }
  })
  for (const { observer, type } of observers) observer.observe({ type })
  const clicks = {}
  let armed
  // The second callback follows the first rendering opportunity after dispatch.
  const afterFrame = () =>
    new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    })
  const onClick = event => {
    if (!event.isTrusted || !armed?.element.contains(event.target)) return
    const { phase } = armed
    armed = undefined
    afterFrame().then(() => {
      clicks[phase] = performance.now() - event.timeStamp
    })
  }
  window.addEventListener('click', onClick, true)
  globalThis.__weworkE2ERendererPerformance = {
    armClick(phase, selector) {
      const element = document.querySelector(selector)
      const rect = element?.getBoundingClientRect()
      if (!rect) throw new Error('Missing switch target ' + selector)
      const x = Math.round((Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2)
      const y = Math.round((Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2)
      if (!element.contains(document.elementFromPoint(x, y))) {
        throw new Error('Switch target does not receive pointer input ' + selector)
      }
      armed = { phase, element }
      return { x, y }
    },
    async stop() {
      window.removeEventListener('click', onClick, true)
      await afterFrame()
      for (const { observer, durations } of observers) {
        for (const entry of observer.takeRecords()) durations.push(entry.duration)
        observer.disconnect()
      }
      delete globalThis.__weworkE2ERendererPerformance
      return { clicks, entries }
    },
  }
  return true
}

function summarize({ timing, cpu, memory, readyMs }) {
  const tasks = timing.entries.longtask
  const frames = timing.entries['long-animation-frame']
  const deltaMs = name => {
    const delta = cpu.end[name] - cpu.start[name]
    assert.ok(Number.isFinite(delta) && delta >= 0, `Invalid renderer CPU counter ${name}`)
    return delta * 1_000
  }
  const resource = key => {
    const samples = memory.map(sample => sample[key])
    const observed = Math.max(...samples)
    return [observed, observed - samples[0]]
  }
  const [observedJsHeapBytes, jsHeapGrowthBytes] = resource('usedSize')
  const [observedDomNodes, domNodeGrowth] = resource('nodes')
  const [observedEventListeners, eventListenerGrowth] = resource('jsEventListeners')
  return {
    clickToFrameMs: Math.max(...PHASES.map(phase => timing.clicks[phase])),
    switchReadyMs: Math.max(...PHASES.map(phase => readyMs[phase])),
    longestTaskMs: Math.max(0, ...tasks),
    longestFrameMs: Math.max(0, ...frames),
    totalBlockingMs: tasks.reduce((sum, duration) => sum + Math.max(0, duration - 50), 0),
    mainThreadMs: deltaMs('TaskDuration'),
    styleAndLayoutMs: deltaMs('RecalcStyleDuration') + deltaMs('LayoutDuration'),
    observedJsHeapBytes,
    jsHeapGrowthBytes,
    observedDomNodes,
    domNodeGrowth,
    observedEventListeners,
    eventListenerGrowth,
  }
}

export async function withRendererPerformanceBudget(control, { resultDir, name }, verify) {
  const evidence = { limits: RENDERER_PERFORMANCE_BUDGET, cpu: {}, memory: [], readyMs: {} }
  const errors = []
  let stop
  let detach
  try {
    await control.command('focusMainWindow', 'body')
    const client = await createDevtoolsClient(resultDir, 5_000)
    const target = (await client({ action: 'targets' })).find(
      entry =>
        entry.type === 'window' &&
        entry.url.includes('/wework/app/') &&
        !entry.url.includes('startup-splash')
    )?.id
    assert.ok(target, 'The isolated Wework renderer is unavailable')
    const command = (method, params) => client({ action: 'command', target, method, params })
    detach = () => client({ action: 'detach', target })
    const evaluate = async expression => {
      const { result, exceptionDetails } = await command('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
      assert.ok(!exceptionDetails, result?.description ?? 'Renderer performance evaluation failed')
      return result.value
    }
    const readCpu = async () =>
      Object.fromEntries(
        (await command('Performance.getMetrics')).metrics
          .filter(({ name }) => CPU_METRICS.includes(name))
          .map(({ name, value }) => [name, value])
      )
    const sampleMemory = async phase => {
      const { usedSize } = await command('Runtime.getHeapUsage')
      const { nodes, jsEventListeners } = await command('Memory.getDOMCounters')
      evidence.memory.push({ phase, usedSize, nodes, jsEventListeners })
    }
    await command('Performance.enable', { timeDomain: 'threadTicks' })
    await sampleMemory('before')
    await evaluate('(' + installProbe.toString() + ')()')
    stop = async () => {
      evidence.timing = await evaluate(PROBE + '.stop()')
      evidence.cpu.end = await readCpu()
      await sampleMemory('after-observation')
    }
    evidence.cpu.start = await readCpu()
    await verify(async (phase, selector, waitForReady) => {
      await control.command('waitFor', selector, { visible: true, enabled: true, timeoutMs: 5_000 })
      const args = [phase, selector].map(value => JSON.stringify(value)).join(', ')
      const point = await evaluate(`${PROBE}.armClick(${args})`)
      const startedAt = performance.now()
      for (const [type, buttons] of [
        ['mousePressed', 1],
        ['mouseReleased', 0],
      ]) {
        await command('Input.dispatchMouseEvent', {
          ...point,
          type,
          buttons,
          button: 'left',
          clickCount: 1,
        })
      }
      await waitForReady()
      evidence.readyMs[phase] = performance.now() - startedAt
      await sampleMemory(phase)
    })
  } catch (error) {
    errors.push(error)
  }
  try {
    await stop?.()
    if (evidence.timing && evidence.cpu.start) {
      evidence.metrics = summarize(evidence)
      assertRendererPerformanceBudget(evidence.metrics)
    }
  } catch (error) {
    errors.push(error)
  } finally {
    await detach?.().catch(error => errors.push(error))
  }
  evidence.errors = errors.map(error => error.message)
  const path = join(resultDir, `renderer-performance-${name}.json`)
  await writeDiagnosticFile(path, evidence).catch(error => errors.push(error))
  if (errors.length)
    throw new AggregateError(
      errors,
      `${name} renderer performance failed (${path}): ${errors.map(error => error.message).join(' | ')}`
    )
}
