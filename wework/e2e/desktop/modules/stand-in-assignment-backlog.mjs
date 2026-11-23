import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { fetchLocalRuntime } from './runtime-request.mjs'

export async function verifyAssignmentBacklogDuringTaskRead(control, cloud, timeoutMs) {
  async function request(path, body) {
    const response = await fetch(`${cloud.backendUrl}/api${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
    assert.ok(response.ok, `${path} returned HTTP ${response.status}`)
    return response.json()
  }

  const name = `Assignment backlog ${process.pid}`
  const user = await request('/users/me')
  const workspace = await request('/v1/workspaces', { name })
  const project = await request('/v1/cloud-projects', {
    workspace_id: workspace.id,
    name,
    task_provider: 'local',
  })
  const popover = '[data-testid="wework-notifications-popover"]'
  const notificationButton = '[data-testid="wework-notifications-button"]'
  await control.command('holdLocalExecutorRequests', 'body', {
    value: JSON.stringify({
      method: 'runtime.stand_in.assignment',
      phase: 'after-response',
    }),
  })
  try {
    const issues = []
    for (let index = 0; index < 8; index++) {
      issues.push(
        await request(`/v1/cloud-projects/${project.id}/loop-items`, {
          title: `${name} ${index}`,
          assignee_user_id: user.id,
        })
      )
    }
    const inbox = await request('/v1/wework-notifications?category=collaboration')
    const itemIds = new Set(issues.map(issue => issue.id))
    const notices = inbox.items.filter(notice => itemIds.has(notice.payload.itemId))
    assert.equal(
      notices.length,
      issues.length,
      'The cloud inbox must contain the assignment backlog'
    )
    await control.command('click', notificationButton)
    await control.command('click', '[data-testid="wework-notifications-category-collaboration"]')
    await control.command('clickWhenEnabled', '[data-testid="wework-notifications-refresh"]')
    for (const notice of notices) {
      await control.command('waitFor', `[data-testid="wework-notification-${notice.id}"]`)
    }
    await control.command('awaitLocalExecutorRequestHold', 'body', { timeoutMs })

    const origin = await control.command('getLocationOrigin', 'body')
    const inventory = await requestExecutor(
      control,
      'runtime.tasks.list',
      { preferCached: true },
      timeoutMs
    )
    assert.ok(Array.isArray(inventory.workspaces), 'The real Executor must return task inventory')
    const owner = await fetchLocalRuntime(control, `${origin}/wework/executor/v1`, {
      timeoutMs,
      headers: { accept: 'application/json' },
    })
    assert.equal(
      owner.ok,
      true,
      'The runtime owner lookup must complete with assignment receipts held'
    )
    assert.ok((await owner.json()).executor.runtime_instance_id)
    const hold = JSON.parse(await control.command('getLocalExecutorRequestHoldSnapshot', 'body'))
    assert.ok(
      hold.heldCount > 0 && hold.heldCount <= 2,
      `Unexpected delivery concurrency: ${JSON.stringify(hold)}`
    )
  } finally {
    await control.command('releaseLocalExecutorRequestHold', 'body')
    if (Number(await control.command('getElementCount', popover)) > 0) {
      await control.command('click', notificationButton)
      await control.command('waitFor', popover, { visible: false })
    }
  }
}
