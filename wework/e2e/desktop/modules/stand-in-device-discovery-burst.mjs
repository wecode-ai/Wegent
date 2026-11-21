import assert from 'node:assert/strict'

export async function verifyStandInDeviceDiscoveryBurst(control, readTraffic) {
  const count = rows => rows.filter(row => row.method === 'runtime.worktrees.capabilities').length
  const before = count(await readTraffic())
  const taskIds = [
    'inventory-waiting',
    ...Array.from({ length: 29 }, (_, index) => `missing-stand-in-task-${index}`),
  ]
  const results = JSON.parse(
    await control.command('readStandInTasksThroughColdDeviceRoute', 'body', {
      value: JSON.stringify(taskIds),
    })
  )
  assert.equal(results.length, taskIds.length)
  assert.equal(results[0].task?.taskId, taskIds[0], 'The real local task must still resolve')
  assert.ok(
    results.slice(1).every(result => !result.success && !result.task),
    'Missing local tasks must remain missing'
  )
  assert.equal(
    count(await readTraffic()) - before,
    1,
    'Concurrent stand-in task reads must share one local capability discovery'
  )
}
