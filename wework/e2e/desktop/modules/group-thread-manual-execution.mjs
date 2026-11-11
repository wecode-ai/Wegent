import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { waitForCompletedRuntimeTaskThread } from './runtime-task-evidence.mjs'
import { verifyGroupThreadBoardPrivacy } from './group-thread-board-privacy.mjs'

export const GROUP_MANUAL_MARKER = `GROUP_MANUAL_RUNTIME_${process.pid}`
export const GROUP_MANUAL_RESULT = '群内事项的手动执行已完成。'

/** Personal manual execution never derives authority from automatic intake. */
export async function verifyGroupManualExecution({
  control,
  request,
  owner,
  member,
  memberToken,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  modelRequests,
  captureScreenshot,
  cloud,
  classificationProject,
}) {
  const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const { group } = await request('/api/v1/chat-groups', {
    method: 'POST',
    body: { name: '独立群手动执行验收' },
  })
  const issue = await request(`/api/v1/cloud-projects/${group.id}/loop-items`, {
    method: 'POST',
    status: 201,
    body: { title: GROUP_MANUAL_MARKER },
  })
  await request(`/api/v1/loop-items/${issue.id}`, {
    method: 'PATCH',
    body: { version: issue.version, assignee_user_id: null },
  })
  const unassigned = await request(`/api/v1/loop-items/${issue.id}`)
  assert.equal(unassigned.assignee_user_id, null)
  const settings = await rpc('runtime.stand_in.personal.get', { userId: owner.id })
  const catalog = await rpc('runtime.runner.catalog', {})
  const model = catalog.models.find(row => row.runtime === 'codex' && row.is_default)
  assert.ok(model, 'The real Runtime catalog must provide its seeded Codex model')
  const roleId = 'group-manual-review'
  await rpc('runtime.stand_in.personal.save', {
    userId: owner.id,
    settings: {
      ...settings,
      roles: [
        ...settings.roles,
        {
          ...settings.roles[0],
          id: roleId,
          name: '群内事项检查',
          enabled: false,
          prompt: GROUP_MANUAL_MARKER,
          model: {
            runtime: model.runtime,
            provider: model.provider,
            model_id: model.model_id,
            source: 'native',
          },
          collaboration: { ...settings.roles[0].collaboration, enabled: false },
        },
      ],
    },
  })
  const participate = joined =>
    request(`/api/v1/loop-items/${issue.id}/participation`, {
      method: 'PUT',
      body: { joined },
    })
  const params = {
    projectId: String(group.id),
    issueId: issue.id,
    userId: owner.id,
    projectStore: 'cloud',
    standInId: roleId,
  }
  await participate(false)
  const observer = await request(`/api/v1/loop-items/${issue.id}`)
  assert.equal(observer.joined, false)
  assert.equal(observer.permissions.execute, false)
  const before = modelRequests()
  await assert.rejects(rpc('runtime.stand_in.run', params), /403 Forbidden/)
  assert.equal(modelRequests(), before)
  assert.deepEqual(await request(`/api/v1/loop-items/${issue.id}/tasks`), [])

  await participate(true)
  const registeredDevice = await cloud.waitForConnectedAppDevice()
  const identity = await rpc('runtime.stand_in.device_identity', {})
  assert.equal(identity.deviceId, registeredDevice.app_device_id)
  assert.equal(identity.backendDeviceId, registeredDevice.execution_target_id)
  const address = await rpc('runtime.stand_in.run', params)
  assert.ok(address.taskId)
  assert.equal(address.deviceId, identity.deviceId)
  await control.command('openWeworkScheme', 'body', {
    value: `wework://groups/backend/${encodeURIComponent(group.id)}/threads/${encodeURIComponent(issue.id)}`,
  })
  const content = '[data-workspace-tab-content][aria-hidden="false"]'
  await control.command('waitFor', `${content} [data-testid="thread-room"]`, {
    text: GROUP_MANUAL_MARKER,
  })
  await control.command('waitFor', `${content} [data-testid="group-message-list"]`, {
    text: GROUP_MANUAL_RESULT,
    timeoutMs: modelResponseTimeoutMs,
  })
  await waitForCompletedRuntimeTaskThread(control, address.taskId, modelResponseTimeoutMs)
  const bindings = await request(`/api/v1/loop-items/${issue.id}/tasks`)
  assert.equal(bindings.length, 1)
  assert.equal(bindings[0].task_user_id, owner.id)
  assert.equal(bindings[0].task_id, address.taskId)
  assert.equal(bindings[0].device_id, identity.backendDeviceId)
  const contextPath = `/api/v1/runtime-tasks/cloud-context?${new URLSearchParams({
    device_id: bindings[0].device_id,
    task_id: bindings[0].task_id,
  })}`
  const context = await request(contextPath)
  assert.equal(String(context.id), String(bindings[0].id))
  assert.equal(String(context.cloud_project_id), String(group.id))
  assert.equal(context.device_id, bindings[0].device_id)
  assert.equal(context.task_id, bindings[0].task_id)
  assert.equal(context.project.resource_type, 'chat_group')
  assert.equal(String(context.project.id), String(group.id))
  assert.equal(context.loop_item.id, issue.id)
  assert.equal(context.loop_item.group_id, String(group.id))
  assert.equal(String(context.loop_item.cloud_project_id), String(group.id))
  assert.equal(context.loop_item_id, issue.id)
  assert.equal(context.task_user_id, owner.id)
  const current = await request(`/api/v1/loop-items/${issue.id}`)
  assert.equal(String(current.cloud_project_id), String(group.id))
  assert.equal(current.assignee_user_id, null)
  assert.equal(modelRequests(), before + 1)
  await request(`/api/v1/chat-groups/${group.id}/members`, {
    method: 'POST',
    body: { user_id: member.id, role: 'Viewer' },
  })
  await request(contextPath, { token: memberToken, status: 404 })
  assert.deepEqual(
    await request(`/api/v1/loop-items/${issue.id}/tasks`, { token: memberToken }),
    []
  )
  await captureScreenshot(control, 'cloud-group-manual-execution.png', content)
  const previewIssue = await request(`/api/v1/loop-items/${issue.id}`, {
    method: 'PATCH',
    body: { version: current.version, status: 'in_review' },
  })
  await verifyGroupThreadBoardPrivacy({
    control,
    cloud,
    request,
    owner,
    member,
    memberToken,
    group,
    issue: previewIssue,
    binding: bindings[0],
    project: classificationProject,
    publicReply: GROUP_MANUAL_RESULT,
    uiTimeoutMs,
    captureScreenshot,
  })
  await request(`/api/v1/chat-groups/${group.id}/members/${member.id}`, {
    method: 'DELETE',
  })
  await request(`/api/v1/loop-items/${issue.id}/tasks`, { token: memberToken, status: 404 })
}
