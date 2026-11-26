import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withCloudRuntimeRequest } from './cloud-runtime-request.mjs'

const ROLE_DEVICE = '[data-testid="stand-in-role-device"]'
const PROFILE_PANEL = '[data-testid="stand-in-profile-panel"]'
const SAVE = '[data-testid="stand-in-save"]'
const PERMISSION =
  '[data-testid="stand-in-task-permissions"] [data-testid="permission-mode-menu-button"]'
const WORKSPACE_WRITE = { permissionMode: 'workspace-write' }

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
  const findRole = settings => settings.roles.find(role => role.id === roleId)
  const readSource = () => rpc('runtime.stand_in.personal.get', { userId: user.id })
  const source = await readSource()
  const sourceRole = findRole(source)
  assert.ok(sourceRole?.enabled, 'The source role must receive work before it moves')
  await rpc('runtime.stand_in.personal.save', {
    userId: user.id,
    settings: {
      ...source,
      roles: source.roles.map(role =>
        role.id === roleId ? { ...role, taskPermissions: WORKSPACE_WRITE } : role
      ),
    },
  })
  const openRole = async device => {
    await control.command('navigate', 'body', {
      value: `/stand-in?${new URLSearchParams({
        deviceId: device,
        profileId: roleId,
        settingsRequest: randomUUID(),
      })}`,
    })
    await control.command('waitFor', ROLE_DEVICE)
  }
  const moveRoleTo = async device => {
    await control.command('select', ROLE_DEVICE, { value: device })
    await control.command('clickWhenEnabled', SAVE)
    await control.command('waitFor', PROFILE_PANEL, { visible: false })
  }
  await openRole(source.executionDeviceId)
  await moveRoleTo(target.device_id)
  const redirected = await until(
    readSource,
    settings => findRole(settings)?.executionDeviceId === target.device_id,
    'The source role must redirect new intake without losing its old task configuration'
  )
  assert.deepEqual(findRole(redirected).taskPermissions, WORKSPACE_WRITE)
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
  assert.equal(bindings[0].device_id, target.device_id)
  await until(
    () => request(`/v1/cloud-projects/${project.id}/loop-items/${issue.id}/activity-comments`),
    rows => rows.some(row => row.body === resultText && row.author === sourceRole.name),
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
  await withCloudRuntimeRequest(environment, async remoteRpc => {
    const readTarget = () =>
      remoteRpc('runtime.stand_in.personal.get', { userId: user.id }, target.device_id)
    const transferred = findRole(await readTarget())
    assert.ok(transferred?.enabled, 'The transfer must activate the role on the target')
    assert.equal(transferred.taskPermissions, undefined, 'The first transfer must start read-only')

    await openRole(target.device_id)
    await control.command('clickWhenEnabled', '[data-testid="stand-in-advanced-open"]')
    await control.command('clickWhenEnabled', `${PERMISSION}[aria-label*="只读"]`)
    await control.command('clickWhenEnabled', '[data-testid="permission-mode-workspace-write"]')
    await control.command('clickWhenEnabled', SAVE)
    await control.command('waitFor', '[data-testid="stand-in-saved"]')
    assert.deepEqual(
      findRole(await readTarget()).taskPermissions,
      WORKSPACE_WRITE,
      'The target owner must still be able to change the imported role’s default'
    )

    await moveRoleTo(source.executionDeviceId)
    const returned = findRole(await readSource())
    assert.ok(returned?.enabled, 'Returning must activate the existing role on its original device')
    assert.equal(returned.executionDeviceId, source.executionDeviceId)
    assert.equal(returned.migrationSource, transferred.migrationSource)
    assert.equal(returned.taskPermissions, undefined, 'A repeat transfer must also start read-only')

    // Address the old receiver directly because its role now redirects to the original device.
    const targetSettings = await readTarget()
    assert.deepEqual(findRole(targetSettings).taskPermissions, WORKSPACE_WRITE)
    await remoteRpc(
      'runtime.stand_in.personal.save',
      {
        userId: user.id,
        settings: {
          ...targetSettings,
          roles: targetSettings.roles.filter(role => role.id !== roleId),
        },
      },
      target.device_id
    )
  })
}
