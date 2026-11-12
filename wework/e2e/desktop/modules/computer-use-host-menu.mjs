import assert from 'node:assert/strict'

/** Invoke a real native tool through the authenticated loopback bridge. */
async function callTool(record, name, args) {
  const response = await fetch(`http://${record.address}/computer`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${record.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action: 'callTool', name, arguments: args }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.json()
  assert.equal(response.ok, true, `Computer use returned HTTP ${response.status}`)
  assert.equal(body.ok, true, `Computer use failed: ${JSON.stringify(body)}`)
  return body.data
}

/** Exercise host-window AX focus and verify that a refused menu leaves it usable. */
export async function verifyComputerUseHostMenu(control, record, timeoutMs) {
  await control.command('focusMainWindow', 'body')
  const state = JSON.parse(await control.command('getNativeWindowState', 'body'))
  assert.equal(state.focused, true, 'The native host menu requires a focused Wework window')
  const result = await callTool(record, 'list_windows', { pid: record.pid })
  assert.equal(result.isError, false, `Window discovery failed: ${result.text}`)
  const { windows } = JSON.parse(result.structuredJson)
  const window = windows.find(
    candidate =>
      candidate.pid === record.pid &&
      ['x', 'y', 'width', 'height'].every(key => candidate.bounds[key] === state.bounds[key])
  )
  assert.ok(window, 'CUA did not discover the exact Wework main window')
  console.log('[computer-use] Native menu target', {
    hostPid: record.pid,
    windowId: window.window_id,
    state,
  })

  // Focus runs before menu resolution. A nonexistent path exercises the crash
  // boundary without executing a product command or changing user data.
  const menu = await callTool(record, 'invoke_menu', {
    pid: record.pid,
    window_id: window.window_id,
    path: ['__wework_e2e_missing_menu__'],
  })
  if (!/invoke_menu: path segment 0.*not found/.test(menu.text)) {
    console.error('[computer-use] Native menu focus diagnostics', {
      result: menu.text,
      hostState: JSON.parse(await control.command('getNativeWindowState', 'body')),
    })
  }
  assert.equal(menu.isError, true, 'The nonexistent menu unexpectedly succeeded')
  assert.match(menu.text, /invoke_menu: path segment 0.*not found/)
  await control.command('waitFor', '[data-testid="app-shell"]', { timeoutMs })
  const after = await callTool(record, 'list_windows', { pid: record.pid })
  assert.equal(after.isError, false, 'Computer use did not survive the host menu request')
  console.log('[computer-use] Native host menu focus, refusal, and continued operation verified')
}
