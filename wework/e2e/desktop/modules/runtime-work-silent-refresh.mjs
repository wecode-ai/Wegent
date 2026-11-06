import assert from 'node:assert/strict'
import { runtimeTransportGates } from './runtime-transport-gates.mjs'
import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'

export async function verifyRuntimeWorkSilentRefresh(control, address) {
  const gates = runtimeTransportGates(control)
  const gateId = 'sidebar-silent-refresh'
  const sidebar = '[data-testid="sidebar-worklists-scroll"]'
  const rowId = `runtime-local-task-row-${address.taskId}`
  await control.command('waitFor', `${sidebar} [data-testid="${rowId}"]`)
  await gates.arm({
    id: gateId,
    kind: 'response',
    name: 'runtime.tasks.list',
  })
  try {
    await control.command('refreshRuntimeWork', 'body', { value: JSON.stringify(address) })
    await gates.wait(gateId)
    // Hold the real response throughout a bounded negative observation window.
    await control.command('startElementMetricsSampling', sidebar, { value: '250' })
    let sample
    const deadline = Date.now() + DEFAULT_STEP_TIMEOUT_MS
    do {
      sample = JSON.parse(await control.command('getElementMetricsSample', 'body'))
      if (sample.done) break
      await new Promise(resolve => setTimeout(resolve, 50))
    } while (Date.now() < deadline)
    assert.ok(sample.done, 'The background-refresh observation did not finish')
    assert.ok(sample.frames.length > 1, 'The pending refresh needs multiple observed frames')
    for (const frame of sample.frames) {
      assert.ok(frame.connected, 'Background refresh detached the task list')
      assert.ok(frame.testIds.includes(rowId), 'Background refresh removed the existing task')
      assert.ok(
        !frame.testIds.includes('runtime-work-load-status'),
        'Background refresh displayed a task-loading status'
      )
    }
  } finally {
    await gates.release(gateId)
  }
  await control.command('waitFor', `${sidebar} [data-testid="${rowId}"]`)
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${sidebar} [data-testid="runtime-work-load-status"]`
      )
    ),
    0,
    'The task-loading status remained after refresh'
  )
}
