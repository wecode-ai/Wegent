import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { readRawRequestBody } from '../e2e/desktop/modules/response-protocol.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR as pane,
  COMPOSER_SELECTOR as composer,
  sse,
  streamingEvents,
  textDeltaEvents,
} from '../e2e/desktop/modules/streaming-text-fixture.mjs'
import {
  createDevtoolsClient,
  startPerformanceRecording,
  stopPerformanceRecording,
  writeDiagnosticFile,
} from './ai-verify-devtools.mjs'

const run = promisify(execFile)
const prompt = 'WEWORK_CPU_BENCHMARK_SINGLE_TASK'
const prefix = 'RENDERER_CPU_BENCHMARK_STREAM_STARTED'
const suffix = 'RENDERER_CPU_BENCHMARK_STREAM_FINISHED'
const idleSamples = 7
const sampleIntervalMs = 1000
const streamPieces = 120
const streamIntervalMs = 100
const limits = {
  idleCpuPercent: 10,
  singleTaskCpuPercent: 15,
  peakObservedJsHeapBytes: 300_000_000,
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
  const { stdout } = await run('ps', ['-p', pids.join(','), '-o', 'time='])
  const counters = stdout.trim().split(/\s+/)
  assert.equal(counters.length, pids.length, 'A measured renderer exited')
  assert.ok(
    counters.every(value => /^\d+(?::\d+)+\.\d+$/.test(value)),
    'Invalid macOS CPU counters'
  )
  const seconds = counters.reduce(
    (total, value) => total + value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0),
    0
  )
  return { seconds, time: performance.now() }
}

function cpuPercent(before, after) {
  return ((after.seconds - before.seconds) * 100_000) / (after.time - before.time)
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

async function emitStream(response) {
  const id = 'wework-benchmark-response'
  const { itemId, start } = streamingEvents(id)
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
  let text = prefix
  response.write(sse([...start, ...textDeltaEvents(itemId, text)]))
  for (let i = 0; i < streamPieces; i++) {
    await setTimeout(streamIntervalMs)
    const delta =
      i === streamPieces - 1
        ? '\n\n' + suffix
        : i % 5 === 0
          ? '\n\n- Streaming item ' + i
          : ' streamed words'
    response.write(sse(textDeltaEvents(itemId, delta, text.length)))
    text += delta
  }
  response.end(sse(streamingEvents(id, text).finish))
}

export function createDesktopScenario({ uiTimeoutMs, resultDir }) {
  const capture = process.env.WEWORK_RENDERER_PROFILE_CAPTURE === 'true'
  const samples = []
  let ready = false
  let started = false
  let finished = false
  let start
  let pids
  return {
    async handleHttp(request, response, url) {
      if (
        !ready ||
        started ||
        request.method !== 'POST' ||
        !['/v1/responses', '/responses'].includes(url.pathname)
      )
        return false
      if (!(await readRawRequestBody(request)).includes(prompt)) return false
      if (started) return false
      started = true
      start = await cpuSnapshot(pids)
      await emitStream(response)
      finished = true
      return true
    },
    async verify(control) {
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
      pids = await rendererPids(control)
      const textTimeoutMs = uiTimeoutMs + streamPieces * streamIntervalMs
      const client = await createDevtoolsClient(resultDir, textTimeoutMs + 5000)
      const targets = await client({ action: 'targets' })
      const target = targets.find(
        entry =>
          entry.type === 'window' &&
          !entry.url.startsWith('devtools:') &&
          !entry.url.includes('startup-splash')
      )?.id
      assert.ok(target, 'The isolated main renderer was not found')
      const sampleHeap = async phase => {
        const { usedSize } = await client({
          action: 'command',
          target,
          method: 'Runtime.getHeapUsage',
        })
        assert.ok(Number.isFinite(usedSize), 'The renderer did not report its used JS heap')
        samples.push({ phase, at: Date.now(), usedSize })
      }
      const reportPath = join(resultDir, 'renderer-performance.json')
      let recording = false
      try {
        const idleStart = await cpuSnapshot(pids)
        for (let i = 0; i < idleSamples; i++) {
          await sampleHeap('idle')
          await setTimeout(sampleIntervalMs)
        }
        const idleEnd = await cpuSnapshot(pids)
        if (capture) {
          await startPerformanceRecording(client, resultDir, target)
          recording = true
        }

        const controller = new AbortController()
        const collect = async () => {
          try {
            while (!controller.signal.aborted) {
              await setTimeout(sampleIntervalMs, undefined, { signal: controller.signal })
              await sampleHeap('running')
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
            await observeText(client, target, prefix, uiTimeoutMs)
            assert.ok(!finished, 'The first response text must appear while streaming')
            await observeText(client, target, suffix, textTimeoutMs)
            return await cpuSnapshot(pids)
          } finally {
            controller.abort()
          }
        }
        const [interaction, sampling] = await Promise.allSettled([interact(), collect()])
        if (interaction.status === 'rejected') throw interaction.reason
        if (sampling.status === 'rejected') throw sampling.reason
        const end = interaction.value
        assert.ok(start, 'The isolated model stream did not start')
        await sampleHeap('settled')
        const measurements = {
          idleCpuPercent: cpuPercent(idleStart, idleEnd),
          singleTaskCpuPercent: cpuPercent(start, end),
          peakObservedJsHeapBytes: Math.max(...samples.map(sample => sample.usedSize)),
        }
        const report = {
          measurements,
          heapSamples: samples,
          rendererPids: pids,
          capture,
          limits,
          withinLimits: capture
            ? null
            : Object.entries(limits).every(([metric, limit]) => measurements[metric] < limit),
        }
        await writeDiagnosticFile(join(resultDir, 'renderer-threshold-measurements.json'), report)
        console.log('[renderer-profile]', JSON.stringify(measurements))
        if (recording) {
          recording = false
          await stopPerformanceRecording(client, resultDir, target, reportPath)
        }
        if (process.env.WEWORK_RENDERER_PROFILE_CHECK === 'true') {
          assert.ok(
            report.withinLimits,
            'Renderer exceeds a limit; see renderer-threshold-measurements.json'
          )
        }
      } finally {
        try {
          if (recording) await stopPerformanceRecording(client, resultDir, target, reportPath)
        } finally {
          await client({ action: 'detach', target })
        }
      }
    },
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('Usage: pnpm --filter wework profile:renderer [--capture | --check] (macOS)')
    return
  }
  assert.equal(process.platform, 'darwin', 'Renderer CPU counters require macOS')
  assert.ok(
    args.length <= 1 && args.every(arg => ['--capture', '--check'].includes(arg)),
    'Use --capture or --check'
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
      WEWORK_E2E_DESKTOP_SCENARIO_MODULE: import.meta.url,
      WEWORK_RENDERER_PROFILE_CAPTURE: String(args.includes('--capture')),
      WEWORK_RENDERER_PROFILE_CHECK: String(args.includes('--check')),
    },
  })
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main()
