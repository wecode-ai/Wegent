import assert from 'node:assert/strict'
import { isTranscriptReadAdmissionBusy } from './runtime-read-admission.mjs'

export async function requestJson(
  baseUrl,
  token,
  pathname,
  options = {},
  deferTranscriptBusy = false
) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const text = await response.text()
  if (
    deferTranscriptBusy &&
    pathname === '/api/runtime-work/transcript' &&
    isTranscriptReadAdmissionBusy(response.status, text)
  )
    return null
  assert.equal(
    response.ok,
    true,
    `${options.method ?? 'GET'} ${pathname} failed with HTTP ${response.status}: ${text}`
  )
  return text ? JSON.parse(text) : null
}

export async function waitForValue(load, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await load()
    const result = predicate(latest)
    if (result) return result === true ? latest : result
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}: ${JSON.stringify(latest)}`)
}

export async function waitForIssueStatus(control, scoped, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]'))
    if (latest === expected) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.fail(`Issue status did not become ${expected}. Last value: ${latest}`)
}

export async function dismissTelemetryConsent(control, timeoutMs) {
  const overlay = '[data-testid="telemetry-consent-overlay"]'
  const count = Number(await control.command('getElementCount', overlay, { visible: true }))
  if (count === 0) return
  await control.command('clickWhenEnabled', '[data-testid="telemetry-consent-decline"]', {
    timeoutMs,
  })
  await control.command('waitForHidden', overlay, { timeoutMs })
}

export async function waitForCompletedMemberTasks(control, scoped, titles, expected, timeoutMs) {
  const activity = scoped('[data-testid="cloud-task-activity-list"]')
  const deadline = Date.now() + timeoutMs
  let completed = 0
  while (Date.now() < deadline) {
    const snapshot = JSON.parse(await control.command('snapshot', activity))
    const taskSummaries = snapshot.testIds.filter(testId =>
      testId.startsWith('cloud-task-activity-task-summary-')
    )
    completed = 0
    for (const taskSummaryTestId of taskSummaries) {
      const activityId = taskSummaryTestId.slice('cloud-task-activity-task-summary-'.length)
      const title = await control.command(
        'getText',
        scoped(`[data-testid="cloud-task-activity-task-title-${activityId}"]`)
      )
      if (!titles.includes(title.trim())) continue
      const badgeTestId = `cloud-task-activity-execution-badge-${activityId}`
      if (!snapshot.testIds.includes(badgeTestId)) continue
      const text = await control.command('getText', `[data-testid="${badgeTestId}"]`)
      if (text.includes('已完成')) completed += 1
    }
    if (completed === expected) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.fail(`Expected ${expected} completed member tasks, received ${completed}`)
}

export async function waitForPromise(promise, timeoutMs, message) {
  let timer
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function waitForCondition(read, predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = read()
    if (predicate(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}. Last value: ${JSON.stringify(latest)}`)
}

export function firstRoundPlan({
  marker,
  firstTask,
  secondTask,
  collectorAgentId,
  reviewerAgentId,
}) {
  return {
    plan: {
      round_id: `${marker}-round-1`,
      summary: '并发采集运行证据并独立复核结论。',
      items: [
        {
          assignment_id: `${marker}-assignment-1`,
          title: firstTask,
          instructions: `${marker}。采集可复核运行证据，不修改 Issue 状态。`,
          assignee_type: 'agent',
          assignee_id: collectorAgentId,
        },
        {
          assignment_id: `${marker}-assignment-2`,
          title: secondTask,
          instructions: `${marker}。独立复核第一项工作的目标和证据，不修改 Issue 状态。`,
          assignee_type: 'agent',
          assignee_id: reviewerAgentId,
        },
      ],
    },
  }
}
