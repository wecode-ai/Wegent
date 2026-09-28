import assert from 'node:assert/strict'

export async function verifyIssueActivityTimeline(control, scope, timeoutMs) {
  const activity = scope('[data-testid="cloud-task-activity-list"]')
  const status = scope('[data-testid="cloud-task-status-event-0"]')
  await control.command('waitFor', status, { timeoutMs })
  await control.command('waitFor', activity, {
    text: '在动态卡片内回复',
    timeoutMs,
  })
  const snapshot = JSON.parse(await control.command('snapshot', activity))
  assert.ok(
    snapshot.testIds.includes('cloud-task-status-event-0'),
    'The Issue creation or status transition is missing from the activity timeline'
  )
  assert.ok(
    snapshot.testIds.some(id => id.startsWith('cloud-task-activity-replies-')),
    'The follow-up reply is missing from its comment thread'
  )
}

export async function verifyCommentExecutionStatus(control, scope, timeoutMs) {
  await control.command(
    'waitFor',
    scope('.task-detail-comment-card [data-testid^="cloud-task-activity-execution-badge-"]'),
    { timeoutMs }
  )
}
