import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { currentExecutorPid, waitForRestartedExecutor } from './executor-restart-readiness.mjs'
import { waitForLogPattern } from './shared.mjs'

/** Fail a real native startup, retain its diagnosis, then retry the same Issue. */
export async function verifyStandInStartupRecovery({
  request,
  rpc,
  project,
  user,
  settings,
  until,
  control,
  resultDir,
  timeoutMs,
}) {
  const role = settings.roles.find(role => role.id === 'recovery-reviewer')
  assert.ok(role)
  const waitForBackend = () =>
    until(
      () => rpc('executor.backend.status', {}),
      result => result.connected === true,
      'The Executor must reconnect to the real Backend before cloud delegation'
    )
  await waitForBackend()
  for (const restart of [false, true]) {
    const created = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
      title: 'Retry a failed native startup after restarting the Executor',
      assignee_user_id: user.id,
      notify_assignee: false,
    })
    const issue = await request(`/v1/loop-items/${created.id}`)
    const taskId = `stand-in-startup-recovery-${process.pid}-${restart}`
    const requiredSkill = `${taskId}-missing-required-skill`
    const device = await rpc('runtime.stand_in.device_identity', {})
    await request(`/v1/loop-items/${issue.id}/tasks`, {
      ...issue.human_task_binding,
      deviceId: device.backendDeviceId,
      taskId,
      taskTitle: issue.title,
    })
    const workspacePath = join(resultDir, `stand-in-startup-workspace-${restart}`)
    await mkdir(workspacePath)
    const origin = {
      type: 'issue_dispatch',
      initiatedBy: 'stand_in',
      standInId: role.id,
      userId: user.id,
      deviceId: settings.executionDeviceId,
      projectStore: 'cloud',
      cloudProjectId: String(project.id),
      loopItemId: issue.id,
      ...issue.human_task_binding,
    }
    // The shared runner removes result-directory workspaces after stopping the app.
    const accepted = await rpc('runtime.tasks.create', {
      taskId,
      title: issue.title,
      runtime: 'codex',
      workspacePath,
      message: issue.title,
      origin,
      executionRequest: {
        task_id: taskId,
        subtask_id: `${taskId}-initial`,
        user_id: user.id,
        prompt: issue.title,
        new_session: true,
        // The real skill deployment stage rejects a missing required artifact
        // before creating a native thread. Only the model service is mocked.
        bot: [{ shell_type: 'Codex', name: role.name, skills: [requiredSkill] }],
        preload_skills: [requiredSkill],
        model_config: {},
        origin,
      },
    })
    assert.equal(accepted.accepted, true)
    const failed = await until(
      () => rpc('runtime.tasks.get', { taskId }),
      result =>
        result.task?.status === 'failed' &&
        result.task?.running === false &&
        (!restart || result.task?.runtimeHandle?.startupFailure?.failedAt > 0),
      'A missing required Skill must fail native startup'
    )
    assert.equal(failed.task.threadId ?? null, null)
    const executorLogPath = join(resultDir, 'executor.log')
    await waitForLogPattern(
      executorLogPath,
      new RegExp(`required Skill deployment failed: ${requiredSkill}`)
    )
    const failure = failed.task.runtimeHandle.startupFailure
    if (restart) {
      assert.equal(failure.code, 'runtime_start_failed')
      assert.ok(failure.message.length > 0)
      assert.ok(failure.failedAt > 0)

      const logOffset = (await readFile(executorLogPath, 'utf8')).length
      const originalPid = await currentExecutorPid(control)
      assert.ok(originalPid)
      process.kill(originalPid, 'SIGTERM')
      await waitForRestartedExecutor({
        control,
        originalPid,
        executorLogPath,
        logOffset,
        timeoutMs,
      })
      await waitForBackend()
      const restored = await rpc('runtime.tasks.get', { taskId })
      assert.equal(restored.task.status, 'failed')
      assert.deepEqual(restored.task.runtimeHandle.startupFailure, failure)
      assert.ok(restored.task.runtimeHandle.startupFailure.message.includes(requiredSkill))
    }

    // Delegation rebuilds the request from the valid role configuration,
    // replacing the rejected attempt's missing deployment plan.
    const retry = await rpc('runtime.stand_in.run', {
      projectId: String(project.id),
      issueId: issue.id,
      userId: user.id,
      projectStore: 'cloud',
      standInId: role.id,
    })
    assert.equal(retry.taskId, taskId)
    const completed = await until(
      () => rpc('runtime.tasks.get', { taskId }),
      result => {
        assert.notEqual(result.task?.status, 'failed', JSON.stringify(result))
        return result.task?.status === 'done' && result.task?.running === false
      },
      'Explicit retry must start the original failed Issue conversation'
    )
    assert.ok(completed.task.threadId)
    assert.equal(completed.task.runtimeHandle.startupFailure.code, 'runtime_start_failed')
    if (failure) assert.deepEqual(completed.task.runtimeHandle.startupFailure, failure)
    const bindings = await request(`/v1/loop-items/${issue.id}/tasks`)
    assert.equal(bindings.length, 1)
    assert.equal(bindings[0].task_id, taskId)
  }
}
