import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { WORKBENCH_READY_TIMEOUT_MS } from './shared.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const RECEIPTS = `${CONTENT} [data-testid="issue-assignment-receipts"]`

export async function reopenReceiptAfterReload(control, open) {
  await reloadMainWindow(control, 'Receipt verification must reconnect after reload')
  // The controller reconnects before the owner finishes loading its project list.
  await waitForValue(
    async () => ({
      roots: Number(
        await control.command(
          'getElementCount',
          `${CONTENT} [data-testid="collaboration-platform-root"]`
        )
      ),
      loading: Number(
        await control.command(
          'getElementCount',
          `${CONTENT} [data-testid="collaboration-loading-skeleton"]`
        )
      ),
    }),
    state => state.roots > 0 && state.loading === 0,
    'The receipt owner must finish startup before notification navigation',
    WORKBENCH_READY_TIMEOUT_MS
  )
  await open()
}

export async function verifyIssueAssignmentReceipts(
  control,
  projectId,
  uiTimeoutMs,
  captureScreenshot
) {
  const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const dismissInbox = async () => {
    const selector = '[data-testid="wework-notifications-popover"]'
    if (Number(await control.command('getElementCount', selector)) > 0) {
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('waitFor', selector, { visible: false })
    }
  }
  const capture = async name => {
    // The shared inbox from notification scenarios must not obscure receipt evidence.
    await dismissInbox()
    assert.equal(
      await control.command('getElementCount', '[data-testid="wework-notifications-popover"]'),
      '0'
    )
    await captureScreenshot(control, name, CONTENT)
  }
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
  await capture('assignment-receipts-01-unread.png')
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
  await capture('assignment-receipts-02-human-read.png')

  await rpc('runtime.stand_in.run', { ...params, issueId: issue.id })
  await control.command('waitFor', RECEIPTS, { text: '分身已接收' })
  await control.command('waitFor', RECEIPTS, { text: '本人已读' })
  const both = (await load())[0]
  assert.ok(both.human_read_at && both.stand_in_received_at)
  await control.command('waitFor', `${RECEIPTS} svg[data-figure="stand-in"]`)
  await capture('assignment-receipts-03-both-received.png')
  await dismissInbox()
  await control.command('hover', `${RECEIPTS} [title^="分身已接收"]`)
  await control.command('waitFor', '[role="tooltip"]', { text: '分身已接收' })
  assert.equal(
    await control.command('getElementCount', '[data-testid="global-icon-button-tooltip"]'),
    '0'
  )
  assert.equal(
    await control.command('getElementCount', '[data-testid="wework-notifications-popover"]'),
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
  await capture('assignment-receipts-03-dark.png')
  await close()
  await control.command('navigate', 'body', { value: '/settings/appearance' })
  await control.command('waitFor', '[data-testid="appearance-settings-page"]')
  await control.command('click', '[data-testid="appearance-mode-light"]')
  await control.command('waitFor', 'html[data-theme="light"]')
  await open()
  await close()
  await reopenReceiptAfterReload(control, open)
  await control.command('waitFor', RECEIPTS, { text: '分身已接收' })
  assert.deepEqual((await load())[0], both, 'Reload must preserve both first-reception timestamps')
  await capture('assignment-receipts-04-persisted.png')
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
  await capture('assignment-receipts-05-reassigned.png')
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
  await verifyIndexedReceipts(issueId, assignments, request, cloud.database)
  await verifyReceiptPermissions(issueId, assignments.items[0], cloud)
}

async function verifyIndexedReceipts(issueId, expected, request, database) {
  const activity = Array.from({ length: 512 }, (_, index) => [
    `receipt-history-${process.pid}-${index}`,
    issueId,
  ])
  await database.executeDatabase(
    `INSERT INTO loop_items (id,resource_type,loop_item_id,description,metadata,created_at,updated_at)
     VALUES ${activity.map(() => "(%s,'comment',%s,'',JSON_OBJECT('event_type','receipt_fixture'),UTC_TIMESTAMP(),UTC_TIMESTAMP())").join(',')}`,
    activity.flat()
  )
  // Emulate an existing Issue with no derived index, while preserving all audit data.
  await database.executeDatabase(
    "DELETE FROM loop_items WHERE parent_id=%s AND resource_type='assignment_index'",
    [issueId]
  )
  const path = `/v1/loop-items/${issueId}/assignments`
  const results = await Promise.all([request(path), request(path)])
  for (const result of results) assert.deepEqual(result, expected)
  const plan = await database.queryDatabase(
    `EXPLAIN SELECT event.id,event.metadata FROM loop_items active
     JOIN loop_items event ON event.id=active.loop_item_id
     WHERE active.parent_id=%s AND active.resource_type='assignment_index' AND event.resource_type='comment'`,
    [issueId]
  )
  const active = plan.find(row => row.table === 'active')
  const event = plan.find(row => row.table === 'event')
  assert.ok(active?.key?.includes('parent') && active.type !== 'ALL', JSON.stringify(plan))
  assert.equal(event?.key, 'PRIMARY', JSON.stringify(plan))
  assert.deepEqual(
    await request(path),
    expected,
    'Warm receipt reads preserve the first timestamps'
  )
}

async function verifyReceiptPermissions(
  issueId,
  assignment,
  { backendUrl, authToken, workspaceId, database }
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
  const device = `receipt-device-${process.pid}`
  const bindingId = `receipt-binding-${process.pid}`
  const [issue] = await database.queryDatabase(
    'SELECT cloud_project_id FROM loop_items WHERE id=%s',
    [issueId]
  )
  await database.executeDatabase(
    "INSERT INTO kinds(user_id,kind,name,namespace,json,is_active,created_at,updated_at) VALUES (%s,'Device',%s,'default',JSON_OBJECT('spec',JSON_OBJECT('deviceType','local')),1,UTC_TIMESTAMP(),UTC_TIMESTAMP())",
    [Number(assignment.target_id), device]
  )
  try {
    await database.executeDatabase(
      "INSERT INTO loop_items(id,resource_type,cloud_project_id,loop_item_id,description,task_user_id,device_id,task_id,linked_by_user_id,linked_at,metadata,created_at,updated_at) VALUES (%s,'execution',%s,%s,'',%s,%s,%s,%s,UTC_TIMESTAMP(),JSON_OBJECT('assignment_id',%s),UTC_TIMESTAMP(),UTC_TIMESTAMP())",
      [
        bindingId,
        issue.cloud_project_id,
        issueId,
        Number(assignment.target_id),
        device,
        bindingId,
        Number(assignment.target_id),
        assignment.id,
      ]
    )
    const payload = { kind: 'stand_in_received', device_id: device, task_id: bindingId }
    await http(authToken, ack, 'POST', payload)
    await database.executeDatabase(
      "UPDATE kinds SET is_active=0 WHERE user_id=%s AND kind='Device' AND namespace='default' AND name=%s",
      [Number(assignment.target_id), device]
    )
    await http(authToken, ack, 'POST', payload, 403)
  } finally {
    await database.executeDatabase('DELETE FROM loop_items WHERE id=%s', [bindingId])
    await database.executeDatabase(
      "DELETE FROM kinds WHERE user_id=%s AND kind='Device' AND namespace='default' AND name=%s",
      [Number(assignment.target_id), device]
    )
  }
  await http(authToken, `${path}/superseded/receipt`, 'POST', { kind: 'human_read' }, 409)
  await http(authToken, ack, 'POST', { kind: 'human_read' })
  const repeated = await http(authToken, path)
  assert.equal(
    repeated.items.find(row => row.id === assignment.id).stand_in_received_at,
    assignment.stand_in_received_at
  )
  assert.equal(
    repeated.items.find(row => row.id === assignment.id).human_read_at,
    assignment.human_read_at
  )
}
