import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import {
  ASSISTANT_CONTENT_SELECTOR,
  COMPOSER_SELECTOR,
  latestModelInputText,
  openNewChatWithE2EModel,
  sse,
  streamingEvents,
  textDeltaEvents,
} from './streaming-text-fixture.mjs'
import { waitForSnapshot } from './conversation-layout.mjs'
import { withTimeout } from './shared.mjs'
import { createModelResponseGates } from './model-response-gates.mjs'

const PROMPT = 'WEWORK_BACKGROUND_WINDOW_REFRESH'
const PREFIX = 'Visible stream prefix.'
const UPDATE = 'New text received while hidden.'
const benchmarkCpu = process.env.WEWORK_E2E_SAMPLE_BACKGROUND_CPU === '1'
const execFileAsync = promisify(execFile)

export function createBackgroundWindowRefreshChecks({ uiTimeoutMs }) {
  const gates = createModelResponseGates()
  const samples = Array.from({ length: 3 }, () => ({
    start: gates.pause(),
    done: Promise.withResolvers(),
  }))
  const progress = gates.pause()
  const completion = gates.pause()

  return {
    cleanup: gates.cleanup,
    async handleModelRequest(body, response, responseId) {
      if (!latestModelInputText(body).includes(PROMPT)) return false
      let text = PREFIX
      const write = (delta, stream) => {
        response.write(sse(textDeltaEvents(stream.itemId, delta, text.length)))
        text += delta
      }
      const sampleDeltas = Array.from(
        { length: 40 },
        (_, index) => `\n\n### Progress ${index}\n- A **streaming update** with inline \`code\`.\n`
      )
      const sampledText = benchmarkCpu ? sampleDeltas.join('').repeat(samples.length) : ''
      const end = `\n\n${UPDATE}`
      const finalText = `${PREFIX}${sampledText}${end}`
      const events = streamingEvents(responseId, finalText)
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.write(sse([...events.start, ...textDeltaEvents(events.itemId, PREFIX)]))
      if (benchmarkCpu) {
        for (const sample of samples) {
          await sample.start.promise
          for (const delta of sampleDeltas) {
            if (response.destroyed) break
            write(delta, events)
            await delay(125)
          }
          sample.done.resolve()
        }
      }
      await progress.promise
      write(end, events)
      await completion.promise
      response.end(sse(events.finish))
      return true
    },
    async verify(control) {
      await control.command('focusMainWindow', 'body')
      await openNewChatWithE2EModel(control, uiTimeoutMs)
      await control.command('fill', COMPOSER_SELECTOR, { value: PROMPT })
      await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
      await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, { text: PREFIX })
      const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      const address = debug.workbench?.currentRuntimeTask
      assert.ok(address?.taskId, 'The streaming task did not acquire a runtime address')
      const readWindows = async () =>
        JSON.parse(await control.command('getWindowFocusSnapshot', 'body'))
      const hidden = async () => {
        await control.command('minimizeMainWindow', 'body')
        await waitForValue(
          () => control.command('getWorkbenchWindowActivity', 'body'),
          value => value === 'hidden',
          'The task window did not minimize',
          uiTimeoutMs
        )
        assert.equal(
          (await readWindows()).popoutVisible,
          true,
          'The second window must stay visible'
        )
      }

      try {
        await control.command('showPopoutWindow', 'body')
        if (benchmarkCpu) {
          await control.command('focusMainWindow', 'body')
          await sampleCpu(control, samples[0], 'foreground')
          await control.command('showPopoutWindow', 'body')
          await sampleCpu(control, samples[1], 'background')
        }
        await hidden()
        if (benchmarkCpu) await sampleCpu(control, samples[2], 'hidden')
        progress.resolve()
        // The live renderer cache must ingest the update without presenting it.
        await waitForValue(
          () =>
            control.command('getRuntimeConversationMessages', 'body', {
              value: JSON.stringify(address),
            }),
          value => value.includes(UPDATE),
          'The hidden window cache did not receive model progress',
          uiTimeoutMs
        )
        // Observe past the foreground cache notification's 100 ms coalescing interval.
        const observationEnd = Date.now() + 300
        do {
          const beforeFocus = JSON.parse(
            await control.command('snapshot', ASSISTANT_CONTENT_SELECTOR)
          )
          assert.ok(!beforeFocus.text.includes(UPDATE), 'Hidden stream progress was rendered early')
          await delay(50)
        } while (Date.now() < observationEnd)
        await control.command('focusMainWindow', 'body')
        await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, { text: UPDATE })

        await hidden()
        completion.resolve()
        const unread = `runtime-local-task-unread-dot-${address.taskId}`
        await waitForSnapshot(
          control,
          snapshot => snapshot.testIds.includes(unread),
          'Task completion did not reach the notification state while hidden'
        )
        assert.equal(await control.command('getWorkbenchWindowActivity', 'body'), 'hidden')
      } finally {
        await control.command('dismissPopoutWindow', 'body')
        await control.command('focusMainWindow', 'body')
      }
    },
  }
}

async function sampleCpu(control, sample, activity) {
  await waitForValue(
    () => control.command('getWorkbenchWindowActivity', 'body'),
    value => value === activity,
    `The task window did not enter the ${activity} CPU sampling phase`,
    3000
  )
  const { processMemory } = JSON.parse(await control.command('performanceSnapshot', 'body'))
  const pids = processMemory?.groups.find(group => group.group === 'webkit-webcontent')?.pids ?? []
  assert.ok(pids.length >= 2, 'CPU sampling requires at least two real renderer processes on macOS')
  const readCpu = async () => {
    const { stdout } = await execFileAsync('ps', ['-p', pids.join(','), '-o', 'time='])
    return stdout
      .trim()
      .split(/\s+/)
      .map(value => value.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0))
      .reduce((sum, value) => sum + value, 0)
  }
  const before = await readCpu()
  const startedAt = performance.now()
  sample.start.resolve()
  await withTimeout(sample.done.promise, 12_000, `The ${activity} CPU workload did not end`)
  const seconds = (performance.now() - startedAt) / 1000
  const cpuSeconds = (await readCpu()) - before
  console.info('[background-window-cpu]', { activity, renderers: pids.length, seconds, cpuSeconds })
}

async function waitForValue(read, predicate, description, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate(await read())) return
    await delay(50)
  }
  assert.fail(description)
}
