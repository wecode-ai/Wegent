import assert from 'node:assert/strict'
import { sendStandInNotificationFollowUp } from './stand-in-flows.mjs'

/** Reuse the real Issue conversation fixture and its existing model response. */
export async function verifyStandInConversationAssignmentIndependence({
  control,
  cloud,
  user,
  project,
  roleId,
  issue,
  taskId,
  deviceId,
  marker,
  rpc,
  request,
  until,
  timeoutMs,
}) {
  const initial = await rpc('runtime.tasks.get', { taskId })
  const settings = await rpc('runtime.stand_in.personal.get', { userId: user.id })
  await rpc('runtime.stand_in.personal.save', {
    userId: user.id,
    settings: {
      ...settings,
      roles: settings.roles.map(role =>
        role.id === roleId
          ? { ...role, enabled: false, collaboration: { ...role.collaboration, enabled: false } }
          : role
      ),
    },
  })
  const comments = target =>
    request(`/v1/cloud-projects/${project.id}/loop-items/${target.id}/activity-comments`)
  await control.command('openWeworkScheme', 'body', {
    value: `wework://tasks/${encodeURIComponent(deviceId)}/${encodeURIComponent(taskId)}`,
  })
  for (const assignee of [null, user.id]) {
    const current = await request(`/v1/loop-items/${issue.id}`)
    const updated = await fetch(`${cloud.backendUrl}/api/v1/loop-items/${issue.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: current.version, assignee_user_id: assignee }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    assert.ok(updated.ok, `Changing assignment failed: ${updated.status} ${await updated.text()}`)
    const before = (await comments(issue)).filter(row => row.body === '已完成本次指派。').length
    await sendStandInNotificationFollowUp(
      control,
      '[data-workspace-tab-content][aria-hidden="false"]',
      `${marker} 请在指派变更为 ${assignee ?? '未指派'} 后继续解释。`
    )
    await until(
      () => comments(issue),
      rows => rows.filter(row => row.body === '已完成本次指派。').length === before + 1,
      'An owned conversation must publish after unassignment or reassignment with intake paused'
    )
    const completed = await until(
      () => rpc('runtime.tasks.get', { taskId }),
      value => value.task?.status === 'done' && value.task.running !== true,
      'The continued conversation must finish'
    )
    assert.equal(completed.task.threadId, initial.task.threadId)
    assert.equal((await request(`/v1/loop-items/${issue.id}/tasks`)).length, 1)
  }
  const unassigned = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
    title: `${marker} automatic role flags manual unassigned`,
    notify_assignee: false,
  })
  const address = await rpc('runtime.stand_in.run', {
    projectId: project.id,
    issueId: unassigned.id,
    userId: user.id,
    projectStore: 'cloud',
    standInId: roleId,
  })
  assert.ok(address.taskId, JSON.stringify(address))
  await until(
    () => comments(unassigned),
    rows => rows.some(row => row.body === '已完成本次指派。'),
    'Manual launch must execute and publish without assignment or automatic intake'
  )
  await until(
    () => rpc('runtime.tasks.get', { taskId: address.taskId }),
    value => value.task?.status === 'done' && value.task.running !== true,
    'The manually launched conversation must finish'
  )
  assert.equal((await request(`/v1/loop-items/${unassigned.id}`)).assignee_user_id, null)
}
