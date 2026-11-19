import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { isReplyPredictionRequest } from '../modules/response-protocol.mjs'
import { runtimeTransportGates } from '../modules/runtime-transport-gates.mjs'

/** Prediction must not retire a live App's native MCP connection after cold restoration. */
export async function verifyMcpPredictionSourceRetention(control, address, frameAction, timeoutMs) {
  const instance = await frameAction('attribute', 'body', 'data-server-instance')
  assert.ok(instance, 'The real MCP service instance must be observed before prediction')
  const predictions = () =>
    control.modelRequests.filter(request => isReplyPredictionRequest(request.body)).length
  const before = predictions()
  const result = await requestExecutor(
    control,
    'runtime.text.predict_reply',
    { address, requestId: randomUUID() },
    timeoutMs
  )
  assert.equal(result.suggestion, null)
  assert.equal(predictions(), before + 1, 'The real prediction fork must reach the model once')
  await frameAction('click', '#heartbeat')
  await waitForMcpAppText(frameAction, 'Heartbeats 3', Date.now() + timeoutMs)
  assert.equal(
    await frameAction('attribute', 'body', 'data-server-instance'),
    instance,
    'Prediction replaced the live MCP service; automatic restoration must not hide its closure'
  )
}

/** Verify the exact app result within the caller's UI or executor-recovery deadline. */
export async function waitForMcpAppText(frameAction, text, deadline) {
  let actual
  do {
    actual = await frameAction('text', '#status')
    if (actual === text) return
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  assert.equal(actual, text)
}

/** Verify a late initialization cannot dispose a replacement app's retained native session. */
export async function verifyMcpReplacementSession(control, callId, sessionIds, timeoutMs) {
  const gates = runtimeTransportGates(control)
  const scope = `[data-testid="mcp-app"][data-mcp-call-id="${callId}"]`
  const where = [
    { path: 'params.callId', equals: callId },
    { path: 'params.method', equals: 'initialize' },
  ]
  await control.command('click', scope + ' [data-testid="mcp-app-close"]')
  await gates.arm({
    id: 'old-app-initialize',
    kind: 'response',
    name: 'runtime.mcp_apps.request',
    where,
  })
  try {
    await control.command('click', scope + ' [data-testid="mcp-app-expand"]')
    const old = await gates.wait('old-app-initialize')
    await control.command('click', scope + ' [data-testid="mcp-app-close"]')
    await gates.arm({
      id: 'new-app-initialize',
      kind: 'response',
      name: 'runtime.mcp_apps.request',
      where,
      hold: false,
    })
    await control.command('click', scope + ' [data-testid="mcp-app-expand"]')
    const replacement = await gates.wait('new-app-initialize')
    const oldSession = old.value.params.sessionId
    const newSession = replacement.value.params.sessionId
    assert.ok(oldSession)
    assert.ok(newSession)
    assert.notEqual(oldSession, newSession)
    await control.command('waitFor', scope + ' [data-testid="mcp-app-frame"][data-ready="true"]')
    await gates.release('old-app-initialize')
    const deadline = Date.now() + timeoutMs
    let sessions
    do {
      sessions = await sessionIds()
      if (!sessions.includes(oldSession)) break
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    assert.equal(
      sessions.includes(oldSession),
      false,
      'Late initialization must release its native instance'
    )
    assert.ok(sessions.includes(newSession), 'The replacement must retain its connection')
    await control.command('waitFor', scope + ' [data-testid="mcp-app-frame"][data-ready="true"]')
    return await control.command('getAttribute', scope + ' [data-testid="mcp-app-frame"]', {
      value: 'src',
    })
  } finally {
    await gates.reset()
  }
}
