import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { requestExecutor } from './executor-rpc.mjs'
import { assertFindInputFocus } from './legacy-history-search.mjs'
import { runtimeTransportGates } from './runtime-transport-gates.mjs'
import { ACTIVE_WORKBENCH_SELECTOR } from './shared.mjs'
import { waitForRestoredTranscript, waitForTranscriptState } from './transcript-restoration.mjs'

const CANCELLATION_TIMEOUT_MS = 3_000

export function transcriptRequestState(log, requestId) {
  const lines = log
    .split('\n')
    .filter(line => line.includes(`request_id=${requestId} method=runtime.tasks.transcript `))
  if (lines.some(line => line.includes('code=request_cancelled '))) return 'cancelled'
  if (lines.some(line => line.includes('app IPC request finished') && line.includes('ok=true')))
    return 'completed'
  if (lines.some(line => line.includes('app IPC request failed'))) return 'failed'
  return 'pending'
}

function startedTranscriptRequests(log) {
  return [
    ...log.matchAll(
      /app IPC request started request_id=(\S+) method=runtime\.tasks\.transcript\b/g
    ),
  ].map(match => match[1])
}

async function waitForExecutorEvidence(read, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const evidence = await read()
    if (predicate(evidence)) return evidence
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail(message)
}

export async function verifyOlderHistoryReadCancellation(
  control,
  { address, otherTaskId, resultDir, timeoutMs }
) {
  const gates = runtimeTransportGates(control)
  const find = '[data-testid="conversation-find-input"]'
  const composer = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
  // Find keeps the reading view stable while an older page is chosen explicitly.
  await control.command('nativePress', composer, {
    key: `${process.platform === 'darwin' ? 'Meta' : 'Control'}+F`,
  })
  await assertFindInputFocus(control, find)
  await control.command('fill', find, { value: '' })
  await gates.reset()
  const settled = await waitForTranscriptState(
    control,
    snapshot =>
      snapshot.pane?.currentRuntimeTask?.taskId === address.taskId &&
      snapshot.pane.transcript.loading === false &&
      snapshot.pane.transcript.loadingMoreBefore === false,
    'The source history did not settle before the cancellation check',
    timeoutMs
  )
  const cursor = settled.pane.transcript.beforeCursor
  assert.ok(cursor, 'The cancellation check requires a real older history page')
  const gateId = 'leaving-older-history-read'
  await gates.arm({
    id: gateId,
    kind: 'request',
    name: 'runtime.tasks.transcript',
    where: [
      { path: 'params.taskId', equals: address.taskId },
      { path: 'params.beforeCursor', equals: cursor },
    ],
  })
  const logPath = join(resultDir, 'executor.log')
  const readLog = () => readFile(logPath, 'utf8')
  try {
    await control.command(
      'click',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="load-older-runtime-transcript-button"]`
    )
    await gates.wait(gateId, undefined, timeoutMs)
    const priorRequests = new Set(startedTranscriptRequests(await readLog()))
    await gates.release(gateId)
    const started = await waitForExecutorEvidence(
      readLog,
      log => startedTranscriptRequests(log).some(id => !priorRequests.has(id)),
      'The older history request never entered the real executor IPC',
      CANCELLATION_TIMEOUT_MS
    )
    const newRequests = startedTranscriptRequests(started).filter(id => !priorRequests.has(id))
    assert.equal(newRequests.length, 1, 'The controlled older page must identify one IPC request')
    const requestId = newRequests[0]
    assert.equal(transcriptRequestState(started, requestId), 'pending')
    await control.command('click', `[data-testid="runtime-local-task-row-${otherTaskId}"]`)
    const cancelled = await waitForExecutorEvidence(
      readLog,
      log => transcriptRequestState(log, requestId) !== 'pending',
      'Leaving the conversation did not cancel its running history read',
      CANCELLATION_TIMEOUT_MS
    )
    assert.equal(
      transcriptRequestState(cancelled, requestId),
      'cancelled',
      'The abandoned older page completed instead of being cancelled in the executor'
    )
    await waitForRestoredTranscript(control, otherTaskId, timeoutMs)
    // Both real admission slots remain usable after the abandoned subscriber exits.
    const pages = await Promise.all(
      [1, 2].map(limit =>
        requestExecutor(control, 'runtime.tasks.transcript', { address, limit }, timeoutMs)
      )
    )
    assert.ok(pages.every(page => Array.isArray(page.turns)))
    await writeFile(
      join(resultDir, 'older-history-cancellation.json'),
      JSON.stringify({ requestId, state: 'cancelled', completedProbeReads: pages.length }, null, 2)
    )
  } finally {
    await gates.reset()
  }
  const returnGate = 'return-after-older-history-cancellation'
  await gates.arm({
    id: returnGate,
    kind: 'response',
    name: 'runtime.tasks.transcript',
    where: [{ path: 'params.taskId', equals: address.taskId }],
  })
  try {
    await control.command('click', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
    await gates.wait(returnGate, undefined, timeoutMs)
    await control.command('nativePress', composer, {
      key: `${process.platform === 'darwin' ? 'Meta' : 'Control'}+F`,
    })
    await assertFindInputFocus(control, find)
    await gates.release(returnGate)
    // Keep find open until the native search assertions take over the reading view.
    await waitForRestoredTranscript(control, address.taskId, timeoutMs)
  } finally {
    await gates.reset()
  }
}
