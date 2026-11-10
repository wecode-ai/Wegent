import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

/** Reuse the suite's real App/cloud Executors, backend and scripted model. */
export async function verifyStandInRoleDeviceChange({
  control,
  environment,
  request,
  rpc,
  until,
  user,
  project,
  roleId,
  marker,
  existingIssue,
  existingTask,
  resultText,
  existingResultText,
}) {
  const target = (await environment.devices()).find(
    device => device.device_type === 'cloud' && device.status === 'online'
  )
  assert.ok(target, 'The shared fixture must expose an online cloud Executor')
  const before = await rpc('runtime.tasks.get', { taskId: existingTask })
  const originalBindings = await request(`/v1/loop-items/${existingIssue.id}/tasks`)
  assert.equal(originalBindings.length, 1)
  const source = await rpc('runtime.stand_in.personal.get', { userId: user.id })
  const openRole = async device => {
    await control.command('navigate', 'body', {
      value: `/stand-in?${new URLSearchParams({
        deviceId: device,
        profileId: roleId,
        settingsRequest: randomUUID(),
      })}`,
    })
    await control.command('waitFor', '[data-testid="stand-in-role-device"]')
  }
  await openRole(source.executionDeviceId)
  await control.command('select', '[data-testid="stand-in-role-device"]', {
    value: target.device_id,
  })
  await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
  await control.command('waitFor', '[data-testid="stand-in-profile-panel"]', { visible: false })
  await until(
    () => rpc('runtime.stand_in.personal.get', { userId: user.id }),
    settings =>
      settings.roles.find(role => role.id === roleId)?.executionDeviceId === target.device_id,
    'The source role must redirect new intake without losing its old task configuration'
  )
  const issue = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
    title: `${marker} after role device change`,
    tags: ['room'],
    assignee_user_id: user.id,
  })
  const bindings = await until(
    () => request(`/v1/loop-items/${issue.id}/tasks`),
    rows => rows.length === 1,
    'New work must be accepted on the role-selected device'
  )
  assert.equal(bindings[0].device_id, target.execution_target_id)
  await until(
    () => request(`/v1/cloud-projects/${project.id}/loop-items/${issue.id}/activity-comments`),
    rows =>
      rows.some(
        row =>
          row.body === resultText &&
          row.author === source.roles.find(role => role.id === roleId).name
      ),
    'The target must execute and publish through the real public-reply path'
  )
  assert.equal(
    (await rpc('runtime.tasks.get', { taskId: bindings[0].task_id })).code,
    'task_not_found'
  )
  const oldComments = () =>
    request(`/v1/cloud-projects/${project.id}/loop-items/${existingIssue.id}/activity-comments`)
  const previousCount = (await oldComments()).filter(row => row.body === existingResultText).length
  await request(
    `/v1/cloud-projects/${project.id}/loop-items/${existingIssue.id}/activity-comments`,
    {
      body: `${marker} continue this existing work after the role device change`,
      mentions: [{ type: 'user', id: String(user.id), label: user.user_name }],
    }
  )
  await until(
    oldComments,
    rows => rows.filter(row => row.body === existingResultText).length === previousCount + 1,
    'Existing Issue work must continue on the original device'
  )
  const after = await until(
    () => rpc('runtime.tasks.get', { taskId: existingTask }),
    value => value.task?.status === 'done' && value.task.running !== true,
    'The original execution must settle on its original Runtime'
  )
  assert.equal(after.task.threadId, before.task.threadId)
  const remainingBindings = await request(`/v1/loop-items/${existingIssue.id}/tasks`)
  assert.equal(remainingBindings.length, 1)
  assert.equal(remainingBindings[0].device_id, originalBindings[0].device_id)
  assert.equal(remainingBindings[0].task_id, existingTask)
  // Remove only the new receiver; the suite's existing cleanup removes its old source copy.
  await openRole(target.device_id)
  await control.command('clickWhenEnabled', '[data-testid="stand-in-role-delete"]')
  await control.command('clickWhenEnabled', '[data-testid="stand-in-role-delete-confirm"]')
  await control.command('waitFor', '[data-testid="stand-in-profile-panel"]', { visible: false })
}
