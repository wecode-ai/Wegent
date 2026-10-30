import assert from 'node:assert/strict'
import { runtimeTransportGates } from '../modules/runtime-transport-gates.mjs'

export async function verifyMcpReplacementLease(control, callId) {
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
    const oldLease = old.value.params.leaseId
    const newLease = replacement.value.params.leaseId
    assert.ok(oldLease)
    assert.ok(newLease)
    assert.notEqual(oldLease, newLease)
    await control.command('waitFor', scope + ' [data-testid="mcp-app-frame"][data-ready="true"]')
    await gates.arm({
      id: 'stale-app-release',
      kind: 'response',
      name: 'runtime.mcp_apps.request',
      hold: false,
      where: [
        { path: 'params.method', equals: 'release' },
        { path: 'params.leaseId', equals: oldLease },
      ],
    })
    await gates.release('old-app-initialize')
    await gates.wait('stale-app-release')
    return await control.command('getAttribute', scope + ' [data-testid="mcp-app-frame"]', {
      value: 'src',
    })
  } finally {
    await gates.reset()
  }
}
