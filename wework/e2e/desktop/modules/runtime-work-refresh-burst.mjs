import assert from 'node:assert/strict'
import { runtimeTransportGates } from './runtime-transport-gates.mjs'

/** Hold real responses while cross-window invalidations exercise the production refresh queue. */
export async function verifyRuntimeWorkRefreshBurst(control, readTraffic) {
  const gates = runtimeTransportGates(control)
  const first = 'work-refresh-burst-first'
  const trailing = 'work-refresh-burst-trailing'
  const fullList = [{ path: 'params.pendingOnly', equals: undefined }]
  const count = async () =>
    (await readTraffic()).filter(row => row.method === 'runtime.tasks.list' && !row.pendingOnly)
      .length
  const before = await count()
  const invalidate = () =>
    control.command('refreshRuntimeWork', 'body', {
      value: JSON.stringify({ deviceId: 'local-device', taskId: 'changed-task' }),
    })
  try {
    await gates.arm({ id: first, kind: 'response', name: 'runtime.tasks.list', where: fullList })
    await invalidate()
    await gates.wait(first)
    for (let index = 0; index < 20; index++) await invalidate()
    assert.equal(await count(), before + 1, 'Work-change events opened overlapping list reads')
    await gates.arm({ id: trailing, kind: 'response', name: 'runtime.tasks.list', where: fullList })
    await gates.release(first)
    await gates.wait(trailing)
    assert.equal(await count(), before + 2, 'Invalidations were not merged into one fresh read')
    await gates.release(trailing)
  } finally {
    await gates.reset()
  }
}
