import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readProjectChatMessages } from './project-chat-snapshot.mjs'
import { isTranscriptReadAdmissionBusy } from './runtime-read-admission.mjs'

export async function assertManagerComment(cloud, projectId, issueId, comments, body, leader) {
  const managerComments = comments.filter(comment => comment.body === body)
  if (managerComments.length !== 1) {
    const stored = await cloud.queryDatabase(
      'SELECT message_id, sender_id, agent_id, message_type, runtime_task_id, ' +
        "JSON_EXTRACT(metadata, '$.dispatch_role') AS dispatch_role, " +
        "JSON_EXTRACT(metadata, '$.activity_type') AS activity_type, " +
        "JSON_EXTRACT(metadata, '$.collaboration_public_reply') AS public_reply " +
        'FROM project_chat_messages WHERE project_id = %s AND task_id = %s AND content = %s',
      [String(projectId), issueId, body]
    )
    assert.fail(`负责人正文应作为一条独立 Issue 评论显示：${JSON.stringify(stored)}`)
  }
  assert.equal(managerComments[0].author, leader)
}
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

export async function assignStoryGroup(control, scoped, groupId, groupName, timeoutMs) {
  await control.command('click', scoped('[data-testid="cloud-todo-detail-assignee"]'))
  await control.command(
    'click',
    `[data-testid="cloud-todo-detail-assignee-option-group:${groupId}"]`
  )
  await control.command('waitFor', scoped('[data-testid="cloud-todo-state-assignee"]'), {
    text: groupName,
    timeoutMs,
  })
}

export function issueExecution(execution, issueId) {
  return String(execution.loopItemId ?? execution.loop_item_id) === String(issueId)
}

export function runtimeDeviceId(execution) {
  return execution.runtimeDeviceId ?? execution.runtime_device_id
}

export function terminalExecution(execution) {
  return ['completed', 'succeeded'].includes(execution.status)
}

export async function verifyRecordedMemberTranscript({
  request,
  backendUrl,
  projectId,
  issueId,
  memberBinding,
  timeoutMs,
}) {
  const userName = 'collaboration-viewer-' + process.pid
  const password = 'isolated-collaboration-viewer-password'
  const viewer = await request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ user_name: userName, password, role: 'user', auth_source: 'password' }),
  })
  await request('/api/v1/cloud-projects/' + projectId + '/members', {
    method: 'POST',
    body: JSON.stringify({ user_id: viewer.id, role: 'Viewer' }),
  })
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ user_name: userName, password }),
  })
  const read = (path, options, deferTranscriptBusy) =>
    requestJson(backendUrl, login.access_token, path, options, deferTranscriptBusy)
  const bindings = await read('/api/v1/loop-items/' + issueId + '/tasks')
  assert.deepEqual(bindings, [], '查看者不应拥有 Executor 的个人会话绑定')
  const activity = await readProjectChatMessages(
    { backendUrl, authToken: login.access_token, projectId: String(projectId) },
    issueId,
    timeoutMs
  )
  const memberActivity = activity.find(
    message =>
      message.metadata.activity_type === 'member_execution' &&
      message.runtimeAddress?.taskId === memberBinding.task_id
  )
  assert.ok(memberActivity, '项目查看者应能从 Issue 动态中获得成员执行入口')
  const address = memberActivity.runtimeAddress
  const transcript = await waitForValue(
    () =>
      read(
        '/api/runtime-work/transcript',
        {
          method: 'POST',
          body: JSON.stringify({
            ...address,
            projectSession: { projectId: String(projectId), issueId },
          }),
        },
        true
      ),
    Boolean,
    '项目查看者无法读取 Issue 内登记的成员会话',
    timeoutMs
  )
  assert.equal(transcript.taskId, address.taskId)
}

export async function assertManagerContinuedOnOriginalTask(runtimeLogPaths, roundId) {
  const receipts = await Promise.all(
    runtimeLogPaths.map(async path => (await readFile(path, 'utf8')).split('\n'))
  )
  const event = 'cloud collaboration manager continuation accepted round_id=' + roundId + ' '
  const records = receipts.find(lines => lines.some(line => line.includes(event)))
  assert.ok(records, '没有原生负责人续跑回执')
  const resumed = records.find(line => line.includes(event))
  const task = resumed.match(/ manager_task_id=(\S+)/)?.[1]
  assert.ok(task?.endsWith('-manager-initial'), '负责人续跑创建了替代会话')
  const turns = records.filter(line =>
    line.includes(
      'runtime native turn boundary applying local_task_id=' + task + ' method=turn/started '
    )
  )
  assert.equal(turns.length, 2, '负责人规划与人工交付后的评估应属于同一个会话的两个回合')
}
