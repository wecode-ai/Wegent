import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'

export async function verifyStandInArchiveRecovery(control, projectId, uiTimeoutMs, timeoutMs) {
  const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const issue = await rpc('todos.create', {
    project_id: projectId,
    todo: { title: 'Resume archived stand-in assignment', assignee_user_id: 9001 },
  })
  const params = { projectId, issueId: issue.id, userId: 9001, projectStore: 'local' }
  const address = await rpc('runtime.stand_in.run', params)
  const waitForCompletion = async () => {
    const deadline = Date.now() + timeoutMs
    let latest
    while (Date.now() < deadline) {
      latest = await rpc('runtime.tasks.get', address)
      assert.notEqual(latest.task?.status, 'failed', JSON.stringify(latest))
      if (latest.task?.status === 'done') return
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.fail(`Stand-in did not complete: ${JSON.stringify(latest)}`)
  }
  const transcript = () =>
    rpc('runtime.tasks.transcript', { ...address, refresh: true, limit: 100 })
  await waitForCompletion()
  const before = await transcript()
  assert.ok(before.turns.length > 0)
  assert.equal((await rpc('runtime.tasks.archive', address)).accepted, true)
  assert.equal((await rpc('runtime.tasks.get', address)).code, 'task_archived')

  const resumed = await rpc('runtime.stand_in.run', params)
  assert.equal(resumed.taskId, address.taskId, 'Recovery must preserve assignment ownership')
  await waitForCompletion()
  const after = await transcript()
  assert.ok(
    after.turns.length > before.turns.length,
    'Manual delegation must execute a new turn instead of acknowledging an archived binding'
  )
  const bindings = await rpc('todos.bindings', { task_id: issue.id })
  assert.equal(bindings.length, 1, 'Recovery must not create a second assignment task')
  assert.equal(bindings[0].task_id, address.taskId)

  await rpc('runtime.stand_in.run', params)
  const repeated = await transcript()
  assert.equal(
    repeated.turns.length,
    after.turns.length,
    'Delegating an already completed visible task must remain idempotent'
  )
}
