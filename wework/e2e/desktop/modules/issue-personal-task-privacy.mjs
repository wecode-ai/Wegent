import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'

/** Reuse the checkpoint's real Issue and completed personal task. */
export async function verifyIssuePersonalTaskPrivacy({
  control,
  request,
  requestJson,
  backendUrl,
  projectId,
  issueId,
  taskId,
  uiTimeoutMs,
}) {
  const userName = `desktop-task-privacy-${process.pid}`
  const password = `isolated-task-privacy-${process.pid}`
  const member = await request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ user_name: userName, password, role: 'user', auth_source: 'password' }),
  })
  await request(`/api/v1/cloud-projects/${projectId}/members`, {
    method: 'POST',
    body: JSON.stringify({ user_id: member.id, role: 'Developer' }),
  })
  const login = await requestJson(null, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ user_name: userName, password }),
  })
  assert.ok(login.access_token)
  const foreign = await requestJson(login.access_token, `/api/v1/loop-items/${issueId}/tasks`, {
    method: 'POST',
    body: JSON.stringify({
      deviceId: 'privacy-device',
      taskId: 'privacy-task',
      taskTitle: 'Private member task',
    }),
  })
  const own = await request(`/api/v1/loop-items/${issueId}/tasks`)
  assert.ok(!own.some(binding => String(binding.task_user_id) === String(member.id)))
  const binding = own.find(candidate => candidate.task_id === taskId)
  assert.ok(binding, 'The checkpoint must supply its completed personal task')
  const address = { deviceId: binding.device_id, taskId: binding.task_id }
  const transcriptRequest = {
    ...address,
    projectSession: { projectId: String(projectId), issueId },
  }
  await request('/api/runtime-work/transcript', {
    method: 'POST',
    body: JSON.stringify(transcriptRequest),
  })
  const memberBindings = await requestJson(
    login.access_token,
    `/api/v1/loop-items/${issueId}/tasks`
  )
  assert.deepEqual(
    memberBindings.map(binding => String(binding.task_user_id)),
    [String(member.id)]
  )
  const snapshot = await request(`/api/v1/cloud-projects/${projectId}/board-snapshot`)
  assert.ok(!snapshot.task_bindings.some(binding => String(binding.id) === String(foreign.id)))
  const denied = await fetch(`${backendUrl}/api/runtime-work/transcript`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${login.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(transcriptRequest),
  })
  assert.equal(
    denied.status,
    404,
    'Issue membership must not authorize another users personal transcript'
  )
  await control.command('openWeworkScheme', 'body', {
    value: `wework://boards/${projectId}/issues/${issueId}`,
  })
  await control.command('waitFor', `${CONTENT} [data-testid="cloud-todo-detail"]`)
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${CONTENT} [data-testid="cloud-todo-open-task-conversation-${foreign.id}"]`
      )
    ),
    0
  )

  const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  assert.equal((await rpc('runtime.tasks.archive', address)).accepted, true)
  try {
    assert.equal((await rpc('runtime.tasks.get', address)).code, 'task_archived')
    const toggle = `${CONTENT} [data-testid="cloud-todo-toggle-tasks"]`
    if ((await control.command('getAttribute', toggle, { value: 'aria-expanded' })) !== 'true') {
      await control.command('click', toggle)
    }
    const openTask = `${CONTENT} [data-testid="cloud-todo-open-task-conversation-${binding.id}"]`
    await control.command('scrollIntoView', openTask)
    await control.command('click', openTask)
    await control.command('waitFor', '[data-testid="transient-notice"]', {
      text: '该任务已归档，请先在归档任务中恢复后再查看。',
    })
    assert.equal(
      Number(await control.command('getElementCount', `${CONTENT} [data-testid="ai-chat-modal"]`)),
      0
    )
  } finally {
    assert.equal((await rpc('runtime.archived_conversations.unarchive', address)).accepted, true)
  }
  assert.equal((await rpc('runtime.tasks.get', address)).success, true)
}
