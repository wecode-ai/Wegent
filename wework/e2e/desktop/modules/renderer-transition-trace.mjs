import { join } from 'node:path'
import {
  collectProtocolEvents,
  createDevtoolsClient,
  readProtocolStream,
  writeDiagnosticFile,
} from '../../../scripts/ai-verify-devtools.mjs'

const TRACE_CATEGORIES = [
  'toplevel',
  'renderer.scheduler',
  'blink',
  'cc',
  'viz',
  'gpu',
  'v8',
  'disabled-by-default-v8.gc',
]

function timingEvidence(trace) {
  // Arguments can contain URLs or page content even without Network.enable.
  // Native event names, thread ids and timings suffice to locate a missed frame.
  return trace.traceEvents.map(event =>
    Object.fromEntries(
      ['name', 'cat', 'ph', 'pid', 'tid', 'ts', 'dur', 'tts', 'tdur']
        .filter(key => event[key] !== undefined)
        .map(key => [key, event[key]])
    )
  )
}

export async function startRendererTransitionTrace(directory, fileName, timeoutMs) {
  let client
  let target
  let cursor
  try {
    client = await createDevtoolsClient(directory, timeoutMs)
    target = (await client({ action: 'targets' })).find(
      entry =>
        entry.type === 'window' &&
        !entry.url.startsWith('devtools:') &&
        !entry.url.includes('startup-splash')
    )?.id
    if (!target) throw new Error('The main renderer is unavailable')
    cursor = (await collectProtocolEvents(client, target)).cursor
    await client({
      action: 'command',
      target,
      method: 'Tracing.start',
      params: {
        transferMode: 'ReturnAsStream',
        traceConfig: {
          recordMode: 'recordUntilFull',
          traceBufferSizeInKb: 4096,
          enableArgumentFilter: true,
          includedCategories: TRACE_CATEGORIES,
        },
      },
    })
  } catch {
    if (target) await client({ action: 'detach', target }).catch(() => {})
    console.info('[issue-drawers] Native transition trace unavailable', { phase: 'start' })
    return async () => {}
  }
  const startedAt = Date.now()
  let ending
  const end = () =>
    (ending ??= client({ action: 'command', target, method: 'Tracing.end' }).catch(() => {
      console.info('[issue-drawers] Native transition trace unavailable', { phase: 'end' })
      return false
    }))
  // Bound recording independently of a stalled action; do not delay the motion.
  const timer = setTimeout(end, Math.min(timeoutMs, 10_000))
  let stopping
  return () =>
    (stopping ??= (async () => {
      clearTimeout(timer)
      try {
        if ((await end()) === false) return
        let complete
        let lost = 0
        const deadline = Date.now() + 2000
        while (!complete) {
          const page = await collectProtocolEvents(client, target, cursor)
          cursor = page.cursor
          lost += page.lost
          complete = page.events.find(event => event.method === 'Tracing.tracingComplete')
          if (!page.attached || Date.now() >= deadline)
            throw new Error('Native trace completion unavailable')
          if (!complete) await new Promise(resolve => setTimeout(resolve, 20))
        }
        if (!complete.params.stream) throw new Error('Native trace stream unavailable')
        const command = (method, params) => client({ action: 'command', target, method, params })
        const trace = JSON.parse(await readProtocolStream(command, complete.params.stream))
        await writeDiagnosticFile(join(directory, fileName), {
          startedAtUnixMs: startedAt,
          finishedAtUnixMs: Date.now(),
          lostEvents: lost,
          dataLossOccurred: complete.params.dataLossOccurred ?? false,
          traceEvents: timingEvidence(trace),
        })
      } catch {
        console.info('[issue-drawers] Native transition trace unavailable', { phase: 'stop' })
      } finally {
        await client({ action: 'detach', target }).catch(() => {})
      }
    })())
}
