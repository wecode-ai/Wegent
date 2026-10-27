import { performance } from 'node:perf_hooks'
import { assert, readFile, DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'

export const MCP_URL_TIMEOUT_MS = 5_000
export const MCP_FORM_TIMEOUT_MS = 30_000

export async function readElicitationEvidence(evidencePath) {
  return (await readFile(evidencePath, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

export async function readMcpInteractions(control, taskId) {
  const transcript = JSON.parse(
    await control.command('getLocalRuntimeTranscript', 'body', {
      value: JSON.stringify({ taskId }),
    })
  )
  assert.equal(transcript.success, true, 'The real executor could not read the task transcript')
  assert.ok(Array.isArray(transcript.turns), 'The executor transcript omitted its native turns')
  assert.ok(Array.isArray(transcript.runtimeTurns), 'The executor omitted its runtime overlays')
  // Match the renderer: runtime-owned state overlays native history by turn/item identity.
  const items = new Map()
  for (const turn of [...transcript.turns, ...transcript.runtimeTurns]) {
    for (const item of turn.items) {
      items.set(JSON.stringify([turn.id, item.id]), item)
    }
  }
  return [...items.values()]
    .filter(item => item.type === 'block')
    .map(item => item.block.render_payload)
    .filter(payload => payload?.kind === 'request_user_input' && payload.interactionScope)
}

export async function readPendingElicitation(control, taskId) {
  const pending = (await readMcpInteractions(control, taskId)).filter(
    payload => payload.interactionStatus === 'pending'
  )
  assert.equal(pending.length, 1, 'The executor must expose exactly one pending MCP interaction')
  assert.ok(pending[0].requestId !== undefined, 'The interaction lost its real request ID')
  return pending[0]
}

export async function readMatchingElicitation(control, taskId, original) {
  const matching = (await readMcpInteractions(control, taskId)).filter(
    payload =>
      String(payload.requestId) === String(original.requestId) &&
      payload.interactionScope === original.interactionScope
  )
  assert.equal(matching.length, 1, 'The transcript lost or duplicated the exact turn/request')
  return matching[0]
}

export async function waitForRealMcpTimeout(evidencePath, scenario, durationMs) {
  const deadline = performance.now() + durationMs + DEFAULT_STEP_TIMEOUT_MS
  let nextProgress = performance.now() + 60_000
  while (performance.now() < deadline) {
    const records = (await readElicitationEvidence(evidencePath)).filter(
      record => record.scenario === scenario && record.event === 'timeout_elicitation_result'
    )
    if (records.length) {
      assert.equal(records.length, 1, 'The real MCP server received duplicate timeout results')
      assert.deepEqual(records[0].result, { action: 'cancel' })
      assert.ok(
        records[0].elapsedMs >= durationMs,
        `The ${scenario} was cancelled before its configured ${durationMs}ms deadline`
      )
      return
    }
    if (performance.now() >= nextProgress) {
      console.log(`Waiting for the real ${scenario} timer (${durationMs}ms); no clock overrides`)
      nextProgress += 60_000
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`The real MCP server did not receive cancel after ${scenario}`)
}
