import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'

export async function verifyLocalStandInStatuses(
  control,
  projectId,
  uiTimeoutMs,
  timeoutMs,
  userId
) {
  const params = { projectId, userId, projectStore: 'local' }
  const rpc = (method, values) => requestExecutor(control, method, values, uiTimeoutMs)
  let settings = await rpc('runtime.stand_in.get', params)
  const setEnabled = async enabled => {
    settings = await rpc('runtime.stand_in.save', {
      ...params,
      settings: { ...settings, enabled },
    })
  }
  const waitForTask = async issue => {
    const deadline = Date.now() + timeoutMs
    let latest
    while (Date.now() < deadline) {
      const bindings = await rpc('todos.bindings', { task_id: issue.id })
      assert.ok(bindings.length <= 1, `Duplicate stand-in tasks for ${issue.id}`)
      if (bindings[0]) {
        latest = await rpc('runtime.tasks.get', { taskId: bindings[0].task_id })
        assert.notEqual(latest.task?.status, 'failed', JSON.stringify(latest))
        if (latest.task?.status === 'done') return bindings[0]
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.fail(`Stand-in did not handle ${issue.status}: ${JSON.stringify(latest)}`)
  }

  await setEnabled(false)
  for (const manual of [true, false]) {
    if (!manual) await setEnabled(true)
    for (const status of ['inbox', 'pending', 'in_progress', 'in_review', 'completed']) {
      const issue = await rpc('todos.create', {
        project_id: projectId,
        todo: {
          title: `Stand-in ${manual ? 'manual' : 'automatic'} ${status}`,
          status,
          // A completed unassigned Issue must also support manual delegation.
          ...(manual && status === 'completed' ? {} : { assignee_user_id: params.userId }),
        },
      })
      if (status === 'completed') assert.ok(issue.completed_at)
      const address = manual
        ? await rpc('runtime.stand_in.run', { ...params, issueId: issue.id })
        : null
      const binding = await waitForTask(issue)
      if (address) assert.equal(binding.task_id, address.taskId)
      const repeated = await rpc('runtime.stand_in.run', { ...params, issueId: issue.id })
      assert.equal(repeated.taskId, binding.task_id, 'Delegation must reuse the assignment task')
      assert.equal((await rpc('todos.bindings', { task_id: issue.id })).length, 1)
    }
  }
  await setEnabled(false)
}
