import assert from 'node:assert/strict'

import { readProjectChatMessages } from './project-chat-snapshot.mjs'
import { createAndAssignCloudIssue, waitForValue } from './workspace-agent-setup.mjs'

async function statusEvents(request, projectId, issueId) {
  const hooksPath = `/api/v1/cloud-projects/${projectId}/incoming-hooks`
  const hooks = (await request(hooksPath)).filter(
    hook => hook.sourceType === 'wework' && hook.collectionMode === 'internal'
  )
  const events = await Promise.all(
    hooks.map(hook => request(`${hooksPath}/${hook.id}/events?limit=200`))
  )
  return events
    .flat()
    .filter(event =>
      event.normalizedEvents.some(
        normalized =>
          normalized.event_type === 'task.status_changed' && normalized.subject.id === issueId
      )
    )
}

async function verifyArchive(control, request, issue, options) {
  const { projectId, contentSelector, cloud, modelRequests, timeoutMs } = options
  const scoped = name => `${contentSelector} [data-testid="${name}"]`
  const executionsPath = `/api/v1/cloud-projects/${projectId}/executions?include_terminal=true`
  const executions = async () =>
    (await request(executionsPath)).items.filter(row => String(row.loopItemId) === String(issue.id))
  const messages = () => readProjectChatMessages({ ...cloud, projectId }, issue.id, timeoutMs)
  const rulesPath = `/api/v1/cloud-projects/${projectId}/automations`
  const user = await request('/api/users/me')
  const rule = await request(rulesPath, {
    method: 'POST',
    body: JSON.stringify({
      name: `Archive must preserve the Issue status-${process.pid}`,
      prompt: 'Review this Issue only after a real transition into review.',
      trigger_type: 'event',
      event_type: 'task.status_changed',
      event_config: {
        transition: 'any',
        statuses: ['in_review'],
        execution_target: 'existing_issue',
      },
      target_kind: 'human',
      target_id: String(user.id),
    }),
  })
  try {
    const assigned = await executions()
    assert.equal(assigned.length, 1, 'The original assignment must own one waiting Run')
    assert.equal(assigned[0].status, 'waiting_runtime')
    await control.command('clickWhenEnabled', scoped(`cloud-todo-card-${issue.id}`))
    await control.command('waitFor', scoped('collaboration-issue-detail'), {
      visible: true,
      timeoutMs,
    })
    await control.command('waitFor', scoped('cloud-todo-detail-title'), {
      value: issue.title,
      timeoutMs,
    })
    await control.command('waitFor', scoped('cloud-todo-detail-status'), {
      value: 'in_progress',
      timeoutMs,
    })
    await control.command('waitFor', scoped(`cloud-task-activity-${issue.id}`), {
      visible: true,
      timeoutMs,
    })
    await control.command('clickWhenEnabled', scoped(`cloud-task-activity-run-now-${issue.id}`))
    const pending = await waitForValue(
      async () => {
        const [runs, activities] = await Promise.all([executions(), messages()])
        return { runs, activities }
      },
      value =>
        value.runs.length === 2 &&
        value.runs.every(row => row.status === 'waiting_runtime') &&
        value.runs.some(row => row.id === assigned[0].id) &&
        value.activities.some(
          row =>
            row.sender.type === 'agent' &&
            row.status === 'pending' &&
            value.runs.some(
              run => run.id !== assigned[0].id && run.id === row.metadata.execution_id
            )
        ),
      'Manual execution must persist a waiting Run with a linked pending Agent activity',
      timeoutMs
    )
    const commentRun = pending.runs.find(row => row.id !== assigned[0].id)
    const linked = pending.activities.filter(
      row => row.sender.type === 'agent' && row.metadata.execution_id === commentRun.id
    )
    assert.equal(
      linked.length,
      1,
      'The new comment Run must have exactly one linked Agent activity'
    )
    const [activity] = linked
    assert.equal(activity.status, 'pending')
    assert.ok(activity.triggerMessageId, 'The pending activity must belong to a real saved comment')
    const before = await request(`/api/v1/loop-items/${issue.id}`)
    assert.equal(before.status, 'in_progress')
    const baseline = {
      runs: await request(`${rulesPath}/${rule.id}/runs`),
      events: await statusEvents(request, projectId, issue.id),
      modelRequests: modelRequests(),
    }
    assert.deepEqual(baseline.runs, [])
    const eventIds = baseline.events.map(row => row.id).sort()

    await control.command('click', scoped('cloud-todo-more-properties'))
    await control.command('clickWhenEnabled', '[data-testid="cloud-todo-detail-delete"]')
    await control.command('waitFor', scoped('collaboration-issue-archive-dialog'), {
      text: issue.title,
      visible: true,
    })
    await control.command('clickWhenEnabled', scoped('collaboration-issue-archive-confirm'))
    await control.command('waitFor', scoped('collaboration-issue-archive-dialog'), {
      visible: false,
    })
    const archived = await request(`/api/v1/cloud-projects/${projectId}/archived-loop-items`)
    assert.equal(archived.items.find(row => row.id === issue.id)?.status, before.status)
    const cancelled = await executions()
    assert.deepEqual(cancelled.map(row => row.id).sort(), pending.runs.map(row => row.id).sort())
    assert.ok(cancelled.every(row => row.status === 'cancelled'))
    await control.command('click', scoped('collaboration-issue-archive-open'))
    await control.command('waitFor', scoped(`collaboration-archived-issue-${issue.id}`), {
      visible: true,
    })
    await control.command(
      'clickWhenEnabled',
      scoped(`collaboration-archived-issue-restore-${issue.id}`)
    )
    await control.command('waitFor', scoped(`collaboration-archived-issue-${issue.id}`), {
      visible: false,
    })
    await control.command('click', scoped('collaboration-issue-archive-drawer-close'))
    await control.command('waitFor', scoped(`collaboration-issue-${issue.id}`), { visible: true })
    assert.equal(
      (await messages()).find(row => row.messageId === activity.messageId)?.status,
      'cancelled'
    )
    // The archive and its linked cancellation have committed. Observe that
    // restoring the Issue cannot manufacture a status event or automation Run.
    const deadline = Date.now() + 1000
    do {
      assert.equal((await request(`/api/v1/loop-items/${issue.id}`)).status, before.status)
      assert.deepEqual(
        (await executions()).map(row => ({ id: row.id, status: row.status })),
        cancelled.map(row => ({ id: row.id, status: row.status }))
      )
      assert.deepEqual(await request(`${rulesPath}/${rule.id}/runs`), baseline.runs)
      assert.deepEqual(
        (await statusEvents(request, projectId, issue.id)).map(row => row.id).sort(),
        eventIds
      )
      assert.equal(modelRequests(), baseline.modelRequests)
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
  } finally {
    await request(`${rulesPath}/${rule.id}`, { method: 'DELETE' })
  }
}

/** Reuse the existing blocked assignment; comment admission needs no model request. */
export async function verifyUnconfiguredAssignment(control, request, options) {
  const { projectId, contentSelector, title, description, timeoutMs, captureScreenshot } = options
  const scoped = selector => `${contentSelector} ${selector}`
  const agent = await request(`/api/v1/cloud-projects/${projectId}/chat-agents`, {
    method: 'POST',
    body: JSON.stringify({
      name: `缺少配置的执行者-${process.pid}`,
      capability_mode: 'manual',
      visibility: 'public',
    }),
  })
  const issue = await createAndAssignCloudIssue(control, request, {
    contentSelector,
    projectId,
    title,
    description,
    assigneeTarget: `agent:${agent.id}`,
    timeoutMs,
  })
  await waitForValue(
    () => request(`/api/v1/loop-items/${issue.id}`),
    item => item.status === 'in_progress' && item.execution_state === 'waiting_runtime',
    'An assigned robot without configuration did not expose its blocked Run',
    timeoutMs
  )
  await control.command('waitFor', scoped('[data-testid="cloud-todo-detail-status"]'), {
    value: 'in_progress',
    timeoutMs,
  })
  await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
  await control.command(
    'waitFor',
    scoped(
      `[data-testid="cloud-todo-column-in_progress"] [data-testid="collaboration-issue-${issue.id}"]`
    ),
    { visible: true, timeoutMs }
  )
  await control.command(
    'waitFor',
    scoped(`[data-testid="cloud-todo-card-needs-execution-config-${issue.id}"]`),
    { text: '待配置', visible: true, timeoutMs }
  )
  await captureScreenshot(
    control,
    'remote-agent-dispatch-00-waiting-configuration.png',
    contentSelector
  )
  await verifyArchive(control, request, issue, options)
}
