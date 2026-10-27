import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const RECEIPTS = `${CONTENT} [data-testid="issue-assignment-receipts"]`

export async function verifyIssueAssignmentReceipts(
  control,
  projectId,
  uiTimeoutMs,
  captureScreenshot
) {
  const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const params = { projectId, userId: 9001, projectStore: 'local' }
  const settings = await rpc('runtime.stand_in.get', params)
  await rpc('runtime.stand_in.save', { ...params, settings: { ...settings, enabled: false } })
  let issue = await rpc('todos.create', {
    project_id: projectId,
    todo: { title: '分配回执：本人和分身独立接收', assignee_user_id: 9002 },
  })
  const load = () => rpc('todos.assignment_receipts', { project_id: projectId, task_id: issue.id })
  const open = async () => {
    await control.command('activateSystemNotification', 'body', {
      value: `wework://boards/local/${projectId}/issues/${issue.id}`,
    })
    await control.command('waitFor', `${CONTENT} [data-testid="cloud-todo-detail-title"]`)
  }
  const close = () => control.command('click', `${CONTENT} [data-testid="cloud-todo-detail-close"]`)
  await open()
  await control.command('waitFor', RECEIPTS, { text: '未读' })
  assert.equal(await control.command('getElementCount', RECEIPTS), '1')
  assert.equal(
    (await load())[0].human_read_at,
    null,
    'The assigner must not acknowledge for the recipient'
  )
  await captureScreenshot(control, 'assignment-receipts-01-unread.png', CONTENT)
  await close()

  issue = await rpc('todos.update', {
    project_id: projectId,
    task_id: issue.id,
    todo: { version: issue.version, assignee_user_id: 9001 },
  })
  await open()
  await control.command('waitFor', RECEIPTS, { text: '本人已读' })
  assert.equal((await load())[0].stand_in_received_at, null)
  await control.command(
    'waitFor',
    `${CONTENT} [data-testid="cloud-todo-detail-assignee"] [data-testid="issue-assignment-receipts"] svg[data-figure="human"]`
  )
  await captureScreenshot(control, 'assignment-receipts-02-human-read.png', CONTENT)

  await rpc('runtime.stand_in.run', { ...params, issueId: issue.id })
  await control.command('waitFor', RECEIPTS, { text: '分身已接收' })
  await control.command('waitFor', RECEIPTS, { text: '本人已读' })
  const both = (await load())[0]
  assert.ok(both.human_read_at && both.stand_in_received_at)
  await control.command('waitFor', `${RECEIPTS} svg[data-figure="stand-in"]`)
  await captureScreenshot(control, 'assignment-receipts-03-both-received.png', CONTENT)
  await control.command('hover', `${RECEIPTS} [title^="分身已接收"]`)
  await control.command('waitFor', '[role="tooltip"]', { text: '分身已接收' })
  assert.equal(
    await control.command('getElementCount', '[data-testid="global-icon-button-tooltip"]'),
    '0'
  )
  await captureScreenshot(control, 'assignment-receipts-03-reception-tooltip.png', CONTENT)
  await close()
  await control.command('navigate', 'body', { value: '/settings/appearance' })
  await control.command('waitFor', '[data-testid="appearance-settings-page"]')
  await control.command('click', '[data-testid="appearance-mode-dark"]')
  await control.command('waitFor', 'html[data-theme="dark"]')
  await open()
  await control.command('waitFor', RECEIPTS, { text: '分身已接收' })
  await captureScreenshot(control, 'assignment-receipts-03-dark.png', CONTENT)
  await close()
  await control.command('navigate', 'body', { value: '/settings/appearance' })
  await control.command('waitFor', '[data-testid="appearance-settings-page"]')
  await control.command('click', '[data-testid="appearance-mode-light"]')
  await control.command('waitFor', 'html[data-theme="light"]')
  await open()
  await close()
  await reloadMainWindow(control, 'Receipt verification must reconnect after reload')
  await open()
  await control.command('waitFor', RECEIPTS, { text: '分身已接收' })
  assert.deepEqual((await load())[0], both, 'Reload must preserve both first-reception timestamps')
  await captureScreenshot(control, 'assignment-receipts-04-persisted.png', CONTENT)
  await close()

  issue = await rpc('todos.get', { project_id: projectId, task_id: issue.id })
  issue = await rpc('todos.update', {
    project_id: projectId,
    task_id: issue.id,
    todo: { version: issue.version, assignee_user_id: 9002 },
  })
  await open()
  await control.command('waitFor', RECEIPTS, { text: '未读' })
  assert.notEqual((await load())[0].id, both.id)
  assert.equal((await load())[0].stand_in_received_at, null)
  await captureScreenshot(control, 'assignment-receipts-05-reassigned.png', CONTENT)
  await close()
}

export async function verifyCloudAssignmentReceipts(
  control,
  issueId,
  request,
  captureScreenshot,
  cloud
) {
  await control.command('waitFor', RECEIPTS, { text: '分身已接收' })
  await control.command('waitFor', RECEIPTS, { text: '本人已读' })
  const assignments = await request(`/v1/loop-items/${issueId}/assignments`)
  assert.ok(assignments.items.some(row => row.human_read_at && row.stand_in_received_at))
  await captureScreenshot(control, 'assignment-receipts-cloud-both.png', CONTENT)
  await verifyReceiptPermissions(issueId, assignments.items[0], cloud)
}

async function verifyReceiptPermissions(
  issueId,
  assignment,
  { backendUrl, authToken, workspaceId }
) {
  const http = async (token, path, method = 'GET', body, expected = 200) => {
    const response = await fetch(`${backendUrl}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    })
    assert.equal(response.status, expected, `${method} ${path} returned ${response.status}`)
    return response.status === 204 ? null : response.json()
  }
  const name = `receipt-peer-${process.pid}`
  const password = 'receipt-e2e-isolated'
  const peer = await http(
    authToken,
    '/admin/users',
    'POST',
    {
      user_name: name,
      password,
      role: 'user',
      auth_source: 'password',
    },
    201
  )
  const login = await http(authToken, '/auth/login', 'POST', { user_name: name, password })
  const path = `/v1/loop-items/${issueId}/assignments`
  const ack = `${path}/${assignment.id}/receipt`
  await http(login.access_token, path, 'GET', undefined, 404)
  await http(login.access_token, ack, 'POST', { kind: 'human_read' }, 404)
  await http(
    authToken,
    `/v1/workspaces/${workspaceId}/members`,
    'POST',
    { user_id: peer.id, role: 'Maintainer' },
    201
  )
  const visible = await http(login.access_token, path)
  assert.ok(visible.items.some(row => row.human_read_at && row.stand_in_received_at))
  await http(login.access_token, ack, 'POST', { kind: 'human_read' }, 403)
  await http(
    authToken,
    ack,
    'POST',
    { kind: 'stand_in_received', device_id: 'unowned', task_id: 'unbound' },
    403
  )
  await http(authToken, `${path}/superseded/receipt`, 'POST', { kind: 'human_read' }, 409)
  await http(authToken, ack, 'POST', { kind: 'human_read' })
  const repeated = await http(authToken, path)
  assert.equal(
    repeated.items.find(row => row.id === assignment.id).human_read_at,
    assignment.human_read_at
  )
}
