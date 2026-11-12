import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { currentExecutorPid, waitForRestartedExecutor } from './executor-restart-readiness.mjs'

/** A binding reserves work; only an accepted native task proves dispatch succeeded. */
export async function verifyOrphanStandInRecovery({
  cloud,
  request,
  rpc,
  project,
  user,
  settings,
  until,
  control,
  executorHome,
  resultDir,
  timeoutMs,
}) {
  const role = settings.roles.find(role => role.id === 'recovery-reviewer')
  assert.ok(role)
  const identity = await rpc('runtime.stand_in.device_identity', {})
  assert.ok(identity.backendDeviceId, 'A new reservation must identify its exact App registration')
  const params = { projectId: String(project.id), userId: user.id, projectStore: 'cloud' }
  const reserve = async title => {
    const created = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
      title,
      assignee_user_id: user.id,
      notify_assignee: false,
    })
    const issue = await request(`/v1/loop-items/${created.id}`)
    const taskId = `stand-in-${issue.human_task_binding.humanAssignmentId}-${role.id}`
    const binding = await request(`/v1/loop-items/${issue.id}/tasks`, {
      ...issue.human_task_binding,
      deviceId: identity.backendDeviceId,
      taskId,
      taskTitle: 'Reserved before a failed start',
    })
    assert.equal(binding.task_id, taskId)
    assert.equal((await rpc('runtime.tasks.get', { taskId })).code, 'task_not_found')
    return { issue, taskId, bindingId: binding.id }
  }
  const completed = async ({ issue, taskId, bindingId }) => {
    await until(
      () => rpc('runtime.tasks.get', { taskId }),
      value => {
        assert.notEqual(value.task?.status, 'failed', JSON.stringify(value))
        return value.task?.status === 'done'
      },
      'A reserved binding without a local task must converge to completed work'
    )
    const bindings = await request(`/v1/loop-items/${issue.id}/tasks`)
    assert.equal(bindings.length, 1, 'Recovery must reuse the reservation')
    assert.equal(bindings[0].id, bindingId, 'Recovery must preserve the original binding identity')
    assert.equal(bindings[0].device_id, identity.backendDeviceId)
    assert.equal(bindings[0].task_id, taskId)
    await until(
      () => request(`/v1/loop-items/${issue.id}/assignments`),
      result => result.items.some(row => row.stand_in_received_at),
      'The recovered task must synchronize its reception receipt'
    )
    return rpc('runtime.tasks.transcript', { taskId, refresh: true, limit: 100 })
  }

  const orphan = await reserve('Recover a cloud reservation left behind by a failed start')
  const address = await rpc('runtime.stand_in.run', { ...params, issueId: orphan.issue.id })
  assert.equal(address.taskId, orphan.taskId)
  const before = await completed(orphan)
  await rpc('runtime.stand_in.run', { ...params, issueId: orphan.issue.id })
  const after = await rpc('runtime.tasks.transcript', {
    taskId: orphan.taskId,
    refresh: true,
    limit: 100,
  })
  assert.equal(after.turns.length, before.turns.length, 'Duplicate delegation must not replay work')

  const interrupted = await reserve('Resume accepted dispatch intent after a backend failure')
  const trigger = `stand_in_dispatch_fault_${process.pid}`
  assert.match(interrupted.taskId, /^[a-zA-Z0-9-]+$/)
  // Fail the actual backend transaction, not an HTTP mock. The existing binding
  // updates its title on acceptance, so the fault occurs before native dispatch.
  await cloud.executeDatabase(
    `CREATE TRIGGER ${trigger} BEFORE UPDATE ON loop_items FOR EACH ROW BEGIN IF NEW.resource_type='execution' AND NEW.task_id='${interrupted.taskId}' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='stand-in dispatch recovery fault'; END IF; END`
  )
  try {
    await assert.rejects(
      rpc('runtime.stand_in.run', { ...params, issueId: interrupted.issue.id }),
      error => {
        assert.ok(error instanceof Error)
        assert.ok(
          error.message.includes(
            `Cloud request POST /v1/loop-items/${interrupted.issue.id}/tasks returned 500 `
          ),
          `The injected transaction must fail its exact bind request: ${error.message}`
        )
        return true
      },
      'The real backend fault must be observable instead of being reported as handled work'
    )
    assert.equal(
      (await rpc('runtime.tasks.get', { taskId: interrupted.taskId })).code,
      'task_not_found'
    )
    const database = new DatabaseSync(join(executorHome, 'data', 'tasks.sqlite'), {
      readOnly: true,
    })
    try {
      const pending = database
        .prepare("SELECT metadata FROM loop_items WHERE resource_type='stand_in_dispatch'")
        .all()
      assert.ok(
        pending.some(row => JSON.parse(row.metadata).issueId === interrupted.issue.id),
        'Startup retry must be durable before returning the error'
      )
    } finally {
      database.close()
    }
    const executorLogPath = join(resultDir, 'executor.log')
    const logOffset = (await readFile(executorLogPath, 'utf8')).length
    const originalPid = await currentExecutorPid(control)
    assert.ok(originalPid)
    process.kill(originalPid, 'SIGTERM')
    await waitForRestartedExecutor({ control, originalPid, executorLogPath, logOffset, timeoutMs })
  } finally {
    await cloud.executeDatabase(`DROP TRIGGER ${trigger}`)
  }
  // No second delegation or notification: the Executor must replay its own intent.
  await completed(interrupted)
  console.log(
    '[stand-in-orphan-binding-recovery] PASS: orphan recovery, idempotency, durable restart and receipt convergence'
  )
}
