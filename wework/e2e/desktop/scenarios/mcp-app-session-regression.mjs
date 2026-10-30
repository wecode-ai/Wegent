import assert from 'node:assert/strict'
import { runtimeTransportGates } from '../modules/runtime-transport-gates.mjs'

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
