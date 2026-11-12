import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { selectWhenOptionAvailable } from './workspace-flows.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'

/** Real cloud Group resource consent, shared execution and subsequent revocation. */
export async function verifyCloudGroupAgent({
  control,
  request,
  member,
  memberToken,
  marker,
  completion,
  modelRequests,
  timeoutMs,
  executionTimeoutMs,
  captureScreenshot,
}) {
  const content = '[data-workspace-tab-content][aria-hidden="false"]'
  const scoped = id => `${content} [data-testid="${id}"]`
  const rpc = (method, params) => requestExecutor(control, method, params, timeoutMs)
  const identity = await rpc('runtime.stand_in.device_identity', {})
  assert.ok(
    identity.backendDeviceId,
    'The real runner must provide its registered backend identity'
  )
  const device = await waitForValue(
    async () => (await request('/api/devices/online')).items,
    rows =>
      rows.find(
        row => String(row.id) === String(identity.backendDeviceId) && row.status === 'online'
      ),
    'The real cloud-connected native runner was not registered',
    timeoutMs
  )
  const catalog = await rpc('runtime.runner.catalog', {})
  const model = catalog.models.find(row => row.runtime === 'codex' && row.is_default)
  assert.ok(model, 'The real native runner must report a configured Codex model')
  const { group } = await request('/api/v1/chat-groups', {
    method: 'POST',
    body: { name: `云端群共享智能体-${process.pid}` },
  })
  await request(`/api/v1/chat-groups/${group.id}/members`, {
    method: 'POST',
    body: { user_id: member.id, role: 'Developer' },
  })
  await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
  await control.command('openWeworkScheme', 'body', {
    value: `wework://groups/backend/${group.id}`,
  })
  await control.command('waitFor', scoped('group-room'), { visible: true, timeoutMs })
  await control.command('clickWhenEnabled', scoped('group-tab-settings'), {
    visible: true,
    timeoutMs,
  })
  await control.command('clickWhenEnabled', scoped('group-resource-tab-devices'), {
    visible: true,
    timeoutMs,
  })
  await control.command('clickWhenEnabled', scoped('group-execution-device-add'), {
    visible: true,
    timeoutMs,
  })
  await control.command(
    'clickWhenEnabled',
    scoped(`group-execution-device-candidate-${device.id}`),
    { visible: true, timeoutMs }
  )
  await control.command('waitFor', scoped(`group-execution-device-${device.id}`), {
    visible: true,
    timeoutMs,
  })
  assert.ok(
    (await request(`/api/v1/cloud-projects/${group.id}/execution-environments`)).items.some(
      row => row.device_id === device.id
    )
  )
  await captureScreenshot(control, 'cloud-group-device-explicit-consent.png', content)
  const agent = await request(`/api/v1/cloud-projects/${group.id}/chat-agents`, {
    method: 'POST',
    status: 201,
    body: {
      name: `群共享执行智能体-${process.pid}`,
      runtime: 'codex',
      model: model.local_model_id,
      model_type: 'runtime',
      system_prompt: `Review the group thread and return the result. ${marker}`,
      execution_policy: { mode: 'project_pool' },
      model_policy: {
        mode: 'fixed',
        model: {
          runtime: model.runtime,
          provider: model.provider,
          model_id: model.model_id,
          source: 'native',
        },
      },
      execution_environment: 'local',
      execution_mode: 'auto',
      workspace_binding: { type: 'standalone' },
    },
  })
  const thread = await request(`/api/v1/cloud-projects/${group.id}/loop-items`, {
    method: 'POST',
    status: 201,
    body: { title: `${marker} 群资源执行`, description: marker },
  })
  assert.equal((await request(`/api/v1/loop-items/${thread.id}/project-link`)).project, null)
  assert.equal(
    (await request(`/api/v1/loop-items/${thread.id}/participation`, { token: memberToken })).joined,
    false
  )
  await request(`/api/v1/cloud-projects/${group.id}/loop-items/${thread.id}/assign`, {
    method: 'POST',
    token: memberToken,
    status: 403,
    body: { version: thread.version, assigneeType: 'agent', assigneeId: String(agent.id) },
  })
  const before = modelRequests()
  await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
  await control.command('openWeworkScheme', 'body', {
    value: `wework://groups/backend/${group.id}/threads/${encodeURIComponent(thread.id)}`,
  })
  await control.command('waitFor', scoped('thread-room'), {
    text: thread.title,
    visible: true,
    timeoutMs,
  })
  await control.command('clickWhenEnabled', scoped('thread-settings'), { timeoutMs, visible: true })
  await selectWhenOptionAvailable(
    control,
    scoped('thread-settings-assignee'),
    `agent:${agent.id}`,
    timeoutMs
  )
  const assigned = await waitForValue(
    () => request(`/api/v1/loop-items/${thread.id}`),
    item => (String(item.assignee_agent_id) === String(agent.id) ? item : false),
    'The group Agent assignment was not persisted',
    timeoutMs
  )
  assert.equal(String(assigned.cloud_project_id), String(group.id))
  await control.command('clickWhenEnabled', scoped('thread-settings-close'), {
    timeoutMs,
    visible: true,
  })
  await control.command('waitFor', scoped('group-message-list'), {
    text: completion,
    visible: true,
    timeoutMs: executionTimeoutMs,
  })
  const executions = async () =>
    (await request(`/api/v1/cloud-projects/${group.id}/executions?include_terminal=true`)).items
  const completed = await waitForValue(
    executions,
    rows => rows.find(row => row.loop_item_id === thread.id && row.status === 'completed'),
    'The actual cloud group execution did not complete on the real native runner',
    executionTimeoutMs
  )
  assert.equal(String(completed.agent_id), String(agent.id))
  assert.ok(completed.runtime_task_id, 'Shared execution must have an actual runtime task')
  assert.equal((await executions()).filter(row => row.loop_item_id === thread.id).length, 1)
  assert.equal(
    modelRequests(),
    before + 1,
    'One assignment must invoke the actual configured model exactly once'
  )
  await captureScreenshot(control, 'cloud-group-agent-execution-without-project.png', content)
  await control.command('clickWhenEnabled', scoped('thread-back-to-group'), {
    visible: true,
    timeoutMs,
  })
  await control.command('clickWhenEnabled', scoped('group-tab-settings'), {
    visible: true,
    timeoutMs,
  })
  await control.command('clickWhenEnabled', scoped('group-resource-tab-devices'), {
    visible: true,
    timeoutMs,
  })
  await control.command('clickWhenEnabled', scoped(`group-execution-device-remove-${device.id}`), {
    visible: true,
    timeoutMs,
  })
  await control.command('waitFor', scoped(`group-execution-device-${device.id}`), {
    visible: false,
    timeoutMs,
  })
  assert.ok(
    !(await request(`/api/v1/cloud-projects/${group.id}/execution-environments`)).items.some(
      row => row.device_id === device.id
    )
  )
  const denied = await request(`/api/v1/cloud-projects/${group.id}/loop-items`, {
    method: 'POST',
    status: 201,
    body: { title: '撤销设备授权后的新事项', description: marker },
  })
  await request(`/api/v1/cloud-projects/${group.id}/loop-items/${denied.id}/assign`, {
    method: 'POST',
    status: 422,
    body: { version: denied.version, assigneeType: 'agent', assigneeId: String(agent.id) },
  })
  assert.equal((await request(`/api/v1/loop-items/${denied.id}`)).assignee_agent_id, null)
  assert.equal((await executions()).filter(row => row.loop_item_id === denied.id).length, 0)
  assert.equal(modelRequests(), before + 1)
}
