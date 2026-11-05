import assert from 'node:assert/strict'

/** Cancel a real bounded native observation after the host reports it active. */
export async function verifyComputerUseCancellation(control, record, timeoutMs) {
  const request = (name, args, signal) =>
    fetch(`http://${record.address}/computer`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${record.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'callTool', name, arguments: args }),
      signal,
    }).then(response => response.json())
  const discovered = await request(
    'list_windows',
    { pid: record.pid },
    AbortSignal.timeout(timeoutMs)
  )
  assert.equal(discovered.ok, true)
  assert.equal(discovered.data.isError, false)
  const { windows } = JSON.parse(discovered.data.structuredJson)
  const window = windows.find(
    candidate => candidate.pid === record.pid && candidate.bounds.height > 100
  )
  assert.ok(window, 'Cancellation requires the isolated host window')

  const controller = new AbortController()
  const operation = request(
    'verify_state',
    {
      pid: record.pid,
      window_id: window.window_id,
      expect: [{ window: { exists: false } }],
      include_screenshot: false,
      timeout_ms: 30_000,
    },
    controller.signal
  ).then(
    value => ({ value }),
    error => ({ error })
  )
  try {
    await control.command('waitFor', '[data-testid="computer-use-activity-indicator"]', {
      text: 'verify_state',
      timeoutMs,
    })
    controller.abort()
    const result = await operation
    assert.equal(result.error?.name, 'AbortError', 'The pending observation was not cancelled')
    await control.command('waitFor', '[data-testid="computer-use-activity-indicator"]', {
      visible: false,
      timeoutMs,
    })
    const after = await request('list_windows', { pid: record.pid }, AbortSignal.timeout(timeoutMs))
    assert.equal(after.ok, true, 'The cancelled observation left action admission occupied')
    assert.equal(after.data.isError, false, 'Native observation did not recover after cancellation')
  } finally {
    controller.abort()
    await operation
  }
}
