import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { since: { type: 'string' }, request: { type: 'string' }, help: { type: 'boolean' } },
})
if (values.help || positionals.length !== 1) {
  console.log(
    'Usage: node wework/scripts/analyze-runtime-rpc.mjs LOG_DIR [--since ISO_DATE] [--request ID]'
  )
  process.exitCode = values.help ? 0 : 1
} else {
  const since = values.since ? Date.parse(values.since) : -Infinity
  if (Number.isNaN(since)) throw new Error('--since must be an ISO date')

  const directory = positionals[0]
  const files = (await readdir(directory)).filter(name =>
    /^(?:executor-transport|dsh-core-runtime)\.log(?:\.\d+)?$/.test(name)
  )
  if (files.length === 0)
    throw new Error('No executor transport or DSH core logs in the supplied directory')

  const requests = new Map()
  for (const file of files) {
    const lines = createInterface({
      input: createReadStream(join(directory, file)),
      crlfDelay: Infinity,
    })
    let at
    for await (const line of lines) {
      const timestamp = line.match(/^(\d{4}-\d\d-\d\dT\S+) \[/)
      if (timestamp) at = Date.parse(timestamp[1])
      const match = line.match(/(?:Executor transport diagnostic |RPC diagnostic )(\{.*\})$/)
      if (!match) continue
      if (!Number.isFinite(at)) continue
      let event
      try {
        event = JSON.parse(match[1])
      } catch {
        continue
      }
      if (!event.requestId || (values.request && event.requestId !== values.request)) continue
      const items = requests.get(event.requestId) ?? []
      // Export only known diagnostic fields, regardless of what the log contains.
      const {
        requestId,
        method,
        route,
        command,
        stage,
        queueMs,
        heldMs,
        released,
        ok,
        bodyBytes,
        elapsedMs,
        status,
        code,
        phase,
        slot,
        reason,
        headersSent,
      } = event
      items.push({
        at,
        requestId,
        method,
        route,
        command,
        event: event.event ?? stage,
        stage,
        queueMs,
        heldMs,
        released,
        ok,
        bodyBytes,
        elapsedMs,
        status,
        code,
        phase,
        slot,
        reason,
        headersSent,
      })
      requests.set(requestId, items)
    }
  }

  const recent = [...requests.values()]
    .filter(events => events.some(event => event.at >= since))
    .map(events => events.sort((a, b) => a.at - b.at))
  if (values.request) {
    const events = recent
      .flat()
      .map(({ at, ...event }) => ({ time: new Date(at).toISOString(), ...event }))
    console.log(JSON.stringify(events, null, 2))
  } else {
    const methods = new Map()
    const outstanding = []
    for (const events of recent) {
      const method =
        events.find(event => event.method && event.method !== '<invalid>')?.method ??
        events.find(event => event.route)?.route ??
        '<invalid>'
      const command = events.find(event => event.command)?.command
      const name = command ? method + ' ' + command : method
      const summary = methods.get(name) ?? {
        method: name,
        requests: 0,
        released: 0,
        timeouts: 0,
        maxQueueMs: 0,
        maxHeldMs: 0,
      }
      summary.requests++
      const released = events.some(event => event.released)
      if (released) summary.released++
      if (
        events.some(
          event =>
            /timeout|deadline_exceeded/.test(event.event) ||
            event.reason === 'timeout' ||
            event.code === 'rpc_timeout' ||
            event.code === 'body_timeout'
        )
      )
        summary.timeouts++
      for (const event of events) {
        summary.maxQueueMs = Math.max(summary.maxQueueMs, event.queueMs ?? 0)
        summary.maxHeldMs = Math.max(summary.maxHeldMs, event.heldMs ?? 0)
      }
      const acquired = events.find(event => event.event === 'background_acquired')
      const queued = events.find(event => event.event === 'background_queued')
      if (
        !released &&
        !events.some(event => event.event === 'background_wait_ended') &&
        (acquired || queued)
      ) {
        const anchor = acquired ?? queued
        outstanding.push({
          requestId: anchor.requestId,
          method: name,
          lastStage: events.at(-1).event,
          state: acquired ? 'no_release_in_logs' : 'no_admission_in_logs',
          since: new Date(anchor.at).toISOString(),
        })
      }
      methods.set(name, summary)
    }
    console.log(
      JSON.stringify(
        {
          files,
          methods: [...methods.values()].sort((a, b) => b.requests - a.requests),
          outstanding,
        },
        null,
        2
      )
    )
  }
}
