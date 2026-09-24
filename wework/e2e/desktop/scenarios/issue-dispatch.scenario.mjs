import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  createSse,
  responseCompleted,
  responseCreated,
  assistantMessage,
} from '../modules/response-protocol.mjs'

const ACTIVE_WORKBENCH = '[data-workspace-tab-content][aria-hidden="false"]'
const AGENT_NAME = '当前设备智能体'
const HUMAN_TASK_TITLE = '整理本周客户反馈'
const AGENT_TASK_TITLE = '检查当前设备 CPU 状态'
const GROUP_AGENT_TASK_TITLE = '采集 CPU 诊断证据'
const GROUP_HUMAN_TASK_TITLE = '复核 CPU 诊断结论'
const MODEL_COMPLETION = 'ISSUE_DISPATCH_E2E_MODEL_COMPLETED'

function selectedCheckpoint() {
  const index = process.argv.indexOf('--segment')
  return index >= 0 ? process.argv[index + 1] : null
}

function scoped(selector) {
  return `${ACTIVE_WORKBENCH} ${selector}`
}

async function requestJson(baseUrl, token, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  assert.equal(
    response.ok,
    true,
    `${options.method ?? 'GET'} ${pathname} failed with HTTP ${response.status}: ${text}`
  )
  return body
}

async function snapshot(control, selector = ACTIVE_WORKBENCH) {
  return JSON.parse(await control.command('snapshot', selector))
}

async function waitForTestId(control, prefix, timeoutMs, text) {
  const deadline = Date.now() + timeoutMs
  let latest = []
  while (Date.now() < deadline) {
    latest = (await snapshot(control)).testIds
    const candidates = latest.filter(value => value.startsWith(prefix))
    if (!text && candidates[0]) return candidates[0]
    for (const candidate of candidates) {
      const selector = scoped(`[data-testid="${candidate}"]`)
      if ((await control.command('getText', selector)).includes(text)) return candidate
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.fail(`Missing test id ${prefix}${text ? ` containing ${text}` : ''}: ${latest.join(', ')}`)
}

async function openBoard(control, timeoutMs) {
  await ensureExperimentalFeaturesEnabled(control)
  await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
    timeoutMs,
  })
  await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
  await control.command('waitFor', scoped('[data-testid="collaboration-platform-root"]'), {
    timeoutMs,
  })
}

async function waitForValue(read, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.fail(`${message}. Last value: ${JSON.stringify(value)}`)
}

async function openFixtureIssue(control, timeoutMs, fixture) {
  await openBoard(control, timeoutMs)
  const workspaceTree = scoped(
    `[data-testid="collaboration-workspace-tree-${fixture.workspace.id}"]`
  )
  await control.command('waitFor', workspaceTree, { timeoutMs })
  await control.command('click', `${workspaceTree} .collaboration-workspace-identity`)
  await control.command(
    'clickWhenEnabled',
    scoped(`[data-testid="collaboration-workspace-project-${fixture.project.id}"]`),
    { timeoutMs }
  )
  await control.command('waitFor', scoped(`[data-testid="cloud-todo-card-${fixture.issue.id}"]`), {
    timeoutMs,
  })
  await control.command('click', scoped(`[data-testid="cloud-todo-card-${fixture.issue.id}"]`))
  await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
    text: fixture.issue.title,
    timeoutMs,
  })
}

async function assertUnifiedBoard(control) {
  const root = scoped('[data-testid="collaboration-platform-root"]')
  const rootSnapshot = await snapshot(control, root)
  assert.equal(
    rootSnapshot.testIds.includes('collaboration-domain-local'),
    false,
    'The unified board still exposed a local domain selector'
  )
  assert.equal(
    rootSnapshot.testIds.includes('collaboration-domain-cloud'),
    false,
    'The unified board still exposed a cloud domain selector'
  )
  assert.equal(
    rootSnapshot.text.includes('本地协作') || rootSnapshot.text.includes('云端协作'),
    false,
    'The unified board still presented local/cloud as separate product modes'
  )
}

async function openDispatch(control, timeoutMs, target) {
  await control.command('click', scoped('[data-testid="issue-dispatch-open"]'))
  await control.command('waitFor', scoped('[data-testid="issue-dispatch-dialog"]'), {
    timeoutMs,
  })
  await control.command('click', scoped(`[data-testid="issue-dispatch-target-${target}"]`))
}

async function chooseFirstCandidate(control, timeoutMs, prefix, text) {
  const testId = await waitForTestId(control, prefix, timeoutMs, text)
  await control.command('click', scoped(`[data-testid="${testId}"]`))
  return testId
}

async function submitDispatch(control, timeoutMs) {
  await control.command('clickWhenEnabled', scoped('[data-testid="issue-dispatch-submit"]'), {
    timeoutMs,
  })
  await control.command('waitFor', scoped('[data-testid="issue-dispatch-dialog"]'), {
    visible: false,
    timeoutMs,
  })
}

async function openAssignedTaskFromNotification(
  control,
  timeoutMs,
  taskTitle,
  capture,
  screenshotPrefix
) {
  await control.command('click', '[data-testid="wework-notifications-button"]')
  await control.command('click', '[data-testid="wework-notifications-category-collaboration"]')
  await control.command('waitFor', '[data-testid="issue-dispatch-notification-create-task"]', {
    text: taskTitle,
    timeoutMs,
  })
  await control.command(
    'clickWhenEnabled',
    '[data-testid="issue-dispatch-notification-create-task"]',
    { timeoutMs }
  )
  await control.command('waitFor', '[data-testid="issue-task-conversation-title"]', {
    text: taskTitle,
    timeoutMs,
  })
  await capture(control, `${screenshotPrefix}-personal-task-composer.png`, 'body')
  await control.command(
    'clickWhenEnabled',
    '[data-testid="ai-chat-modal"] [data-testid="send-message-button"]',
    { timeoutMs }
  )
  await control.command('waitFor', '[data-testid="ai-chat-open-runtime-task"]', {
    timeoutMs,
  })
  await control.command('click', '[data-testid="ai-chat-open-runtime-task"]')
  await control.command('waitFor', '[data-testid="environment-info-button"]', { timeoutMs })
  await capture(control, `${screenshotPrefix}-personal-task-running.png`, 'body')
}

async function deliverActiveTask(control, timeoutMs, summary) {
  if (
    Number(await control.command('getElementCount', '[data-testid="environment-info-popover"]')) ===
    0
  ) {
    await control.command('click', '[data-testid="environment-info-button"]')
  }
  await control.command('waitFor', '[data-testid="environment-info-popover"]', { timeoutMs })
  await control.command('click', '[data-testid="environment-delivery-button"]')
  await control.command('waitFor', '[data-testid="delivery-markdown"]', { timeoutMs })
  await control.command('fill', '[data-testid="delivery-markdown"]', { value: summary })
  await control.command('click', '[data-testid="delivery-chat-conversation"]')
  await control.command('clickWhenEnabled', '[data-testid="delivery-confirm"]', { timeoutMs })
  await control.command('waitFor', '[data-testid="delivery-complete-dialog"]', { timeoutMs })
  await control.command('clickWhenEnabled', '[data-testid="delivery-complete-confirm"]', {
    timeoutMs,
  })
}

async function verifyUnifiedBoard(control, timeoutMs, fixture) {
  await assertUnifiedBoard(control)
  const detail = await snapshot(control, scoped('[data-testid="collaboration-issue-detail"]'))
  assert.equal(
    /本地 Issue|云端 Issue|本地看板|云端看板/.test(detail.text),
    false,
    'Issue detail exposed separate local/cloud board semantics'
  )
}

async function verifyHumanDispatch(control, timeoutMs, fixture, capture) {
  await capture(control, '01-human-issue-before-dispatch.png')
  await openDispatch(control, timeoutMs, 'human')
  await chooseFirstCandidate(
    control,
    timeoutMs,
    'issue-dispatch-candidate-human-',
    fixture.owner.user_name
  )
  await control.command('fill', scoped('[data-testid="issue-dispatch-task-title"]'), {
    value: HUMAN_TASK_TITLE,
  })
  await control.command('fill', scoped('[data-testid="issue-dispatch-task-instructions"]'), {
    value: '汇总三条反馈并提交可核验交付。',
  })
  await capture(control, '02-human-dispatch-ready.png')
  await submitDispatch(control, timeoutMs)

  await control.command('waitFor', scoped('[data-testid^="issue-dispatch-assignment-event-"]'), {
    text: `将「${HUMAN_TASK_TITLE}」分配给 ${fixture.owner.user_name}`,
    timeoutMs,
  })
  await capture(control, '03-human-assignment-recorded.png')
  await openAssignedTaskFromNotification(control, timeoutMs, HUMAN_TASK_TITLE, capture, '04-human')
  await deliverActiveTask(control, timeoutMs, '已汇总反馈并附上核验摘要。')
  await capture(control, '06-human-delivery-submitted.png', 'body')
  await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
  await control.command(
    'waitFor',
    scoped(
      `[data-testid="cloud-todo-column-in_review"] [data-testid="cloud-todo-card-${fixture.issue.id}"]`
    ),
    { timeoutMs }
  )
  await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
  await control.command(
    'click',
    scoped(
      `[data-testid="cloud-todo-column-in_review"] [data-testid="cloud-todo-card-${fixture.issue.id}"]`
    )
  )
  await control.command('waitFor', scoped('[data-testid="cloud-todo-detail-status"]'), {
    timeoutMs,
  })
  assert.equal(
    await control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]')),
    'in_review',
    'A delivered direct human dispatch did not move the Issue to in_review'
  )
  await capture(control, '07-human-issue-in-review.png')
}

async function verifyAgentDispatch(control, timeoutMs, modelTimeoutMs, fixture, capture) {
  const issueTitle = fixture.issue.title
  await capture(control, '01-agent-issue-before-dispatch.png')
  await openDispatch(control, timeoutMs, 'agent')
  await chooseFirstCandidate(control, timeoutMs, 'issue-dispatch-candidate-agent-', AGENT_NAME)
  await control.command('fill', scoped('[data-testid="issue-dispatch-task-title"]'), {
    value: AGENT_TASK_TITLE,
  })
  await control.command('fill', scoped('[data-testid="issue-dispatch-task-instructions"]'), {
    value: '只读采集两次 CPU 数据并提交结论。',
  })
  await capture(control, '02-agent-dispatch-ready.png')
  await submitDispatch(control, timeoutMs)

  const task = scoped('[data-testid^="issue-dispatch-task-activity-"]')
  await control.command('waitFor', task, { text: AGENT_TASK_TITLE, timeoutMs: modelTimeoutMs })
  const taskText = await control.command('getText', task)
  assert.equal(
    taskText.includes(issueTitle),
    false,
    'The executor activity used the Issue title instead of the delegated task title'
  )
  const avatar = `${task} [data-testid="issue-dispatch-assignee-avatar"]`
  assert.equal(
    await control.command('getAttribute', avatar, { value: 'title' }),
    AGENT_NAME,
    'The task avatar did not expose the Agent name on hover'
  )
  await capture(control, '03-agent-executing-delegated-title.png')
  await control.command('waitFor', `${task}[data-status="succeeded"]`, {
    timeoutMs: modelTimeoutMs,
  })
  assert.equal(
    await control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]')),
    'in_review',
    'A successful direct Agent dispatch did not move the Issue to in_review'
  )
  await capture(control, '04-agent-delivered-in-review.png')
}

async function fillRoundTask(control, timeoutMs, index, title, assigneePrefix, assigneeText) {
  const row = scoped(`[data-testid="issue-dispatch-round-task-${index}"]`)
  await control.command('fill', `${row} [data-testid="issue-dispatch-round-task-title"]`, {
    value: title,
  })
  await control.command('fill', `${row} [data-testid="issue-dispatch-round-task-instructions"]`, {
    value: `完成「${title}」并提交可复核证据。`,
  })
  await control.command('click', `${row} [data-testid="issue-dispatch-round-task-assignee"]`)
  const candidate = `${row} [data-testid^="${assigneePrefix}"]`
  await control.command('waitFor', candidate, { text: assigneeText, timeoutMs })
  await control.command('click', candidate, { text: assigneeText })
}

async function verifyGroupRound(control, timeoutMs, modelTimeoutMs, fixture, capture) {
  const groupName = fixture.group.name
  await capture(control, '01-group-issue-before-dispatch.png')
  await openDispatch(control, timeoutMs, 'group')
  await chooseFirstCandidate(control, timeoutMs, 'issue-dispatch-candidate-group-', groupName)
  await control.command('fill', scoped('[data-testid="issue-dispatch-task-title"]'), {
    value: `调查 CPU 异常-${process.pid}`,
  })
  await control.command('fill', scoped('[data-testid="issue-dispatch-task-instructions"]'), {
    value: '负责人按轮次分配任务，汇总成员交付后决定 Issue 状态。',
  })
  await submitDispatch(control, timeoutMs)
  await control.command(
    'waitFor',
    scoped('[data-testid="issue-dispatch-leader-action-required"]'),
    {
      timeoutMs,
    }
  )
  await control.command('click', scoped('[data-testid="issue-dispatch-round-open"]'))
  await control.command('waitFor', scoped('[data-testid="issue-dispatch-round-dialog"]'), {
    timeoutMs,
  })
  await fillRoundTask(
    control,
    timeoutMs,
    0,
    GROUP_AGENT_TASK_TITLE,
    'issue-dispatch-round-assignee-agent-',
    AGENT_NAME
  )
  await control.command('click', scoped('[data-testid="issue-dispatch-round-add-task"]'))
  await fillRoundTask(
    control,
    timeoutMs,
    1,
    GROUP_HUMAN_TASK_TITLE,
    'issue-dispatch-round-assignee-human-',
    fixture.owner.user_name
  )
  await capture(control, '02-group-leader-round-editor.png')
  await control.command('clickWhenEnabled', scoped('[data-testid="issue-dispatch-round-submit"]'), {
    timeoutMs,
  })
  await control.command('waitFor', scoped('[data-testid^="issue-dispatch-round-event-"]'), {
    text: `将「${GROUP_AGENT_TASK_TITLE}」分配给 ${AGENT_NAME}`,
    timeoutMs,
  })
  await control.command('waitFor', scoped('[data-testid^="issue-dispatch-round-event-"]'), {
    text: `将「${GROUP_HUMAN_TASK_TITLE}」分配给`,
    timeoutMs,
  })
  await control.command('waitFor', scoped('[data-testid^="issue-dispatch-task-activity-"]'), {
    text: GROUP_AGENT_TASK_TITLE,
    timeoutMs: modelTimeoutMs,
  })
  await control.command('waitFor', scoped('[data-testid^="issue-dispatch-task-activity-"]'), {
    text: GROUP_HUMAN_TASK_TITLE,
    timeoutMs,
  })
  await capture(control, '03-group-concurrent-round-assigned.png')
  const status = await control.command(
    'getValue',
    scoped('[data-testid="cloud-todo-detail-status"]')
  )
  assert.equal(status, 'in_progress', 'A member task changed the group Issue status directly')
  await control.command('waitFor', scoped('[data-testid="issue-dispatch-round-progress"]'), {
    text: '1 / 2',
    timeoutMs: modelTimeoutMs,
  })
  await capture(control, '04-group-agent-finished-human-pending.png')
  await openAssignedTaskFromNotification(
    control,
    timeoutMs,
    GROUP_HUMAN_TASK_TITLE,
    capture,
    '05-group-human'
  )
  await deliverActiveTask(control, timeoutMs, '已复核 CPU 诊断结论，证据与结论一致。')
  await openFixtureIssue(control, timeoutMs, fixture)
  await control.command('waitFor', scoped('[data-testid="issue-dispatch-round-progress"]'), {
    text: '2 / 2',
    timeoutMs: modelTimeoutMs,
  })
  await control.command(
    'waitFor',
    scoped('[data-testid="issue-dispatch-leader-action-required"]'),
    {
      timeoutMs: modelTimeoutMs,
    }
  )
  assert.equal(
    await control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]')),
    'in_progress',
    'A human member Delivery changed the group Issue status before the leader decision'
  )
  await capture(control, '05-group-round-complete-leader-required.png')
  await control.command('click', scoped('[data-testid="issue-dispatch-leader-decide"]'))
  await control.command('select', scoped('[data-testid="issue-dispatch-decision-status"]'), {
    value: 'in_review',
  })
  await control.command('fill', scoped('[data-testid="issue-dispatch-decision-reason"]'), {
    value: '两位成员均已提交可复核证据。',
  })
  await control.command(
    'clickWhenEnabled',
    scoped('[data-testid="issue-dispatch-decision-submit"]'),
    { timeoutMs }
  )
  assert.equal(
    await control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]')),
    'in_review',
    'The human leader decision did not move the Issue to in_review'
  )
  await capture(control, '06-group-leader-decision-in-review.png')
}

async function verifyCancellation(
  control,
  timeoutMs,
  modelTimeoutMs,
  releaseModel,
  fixture,
  capture,
  abortedCount
) {
  await capture(control, '01-cancel-issue-before-dispatch.png')
  await openDispatch(control, timeoutMs, 'agent')
  await chooseFirstCandidate(control, timeoutMs, 'issue-dispatch-candidate-agent-', AGENT_NAME)
  await control.command('fill', scoped('[data-testid="issue-dispatch-task-title"]'), {
    value: '等待取消的设备检查',
  })
  await control.command('fill', scoped('[data-testid="issue-dispatch-task-instructions"]'), {
    value: '等待模型结果，用于验证取消闭环。',
  })
  await submitDispatch(control, timeoutMs)
  const task = scoped('[data-testid^="issue-dispatch-task-activity-"]')
  await control.command('waitFor', `${task}[data-status="running"]`, {
    timeoutMs: modelTimeoutMs,
  })
  await control.command('waitFor', `${task} [data-testid="issue-dispatch-task-cancel"]`, {
    timeoutMs: modelTimeoutMs,
  })
  await capture(control, '02-cancel-agent-running.png')
  await control.command('click', `${task} [data-testid="issue-dispatch-task-cancel"]`)
  await control.command('waitFor', '[data-testid="issue-dispatch-cancel-dialog"]', { timeoutMs })
  await capture(control, '03-cancel-confirmation.png', 'body')
  await control.command('click', '[data-testid="issue-dispatch-cancel-confirm"]')
  await control.command('waitFor', `${task}[data-status="cancelled"]`, {
    timeoutMs: modelTimeoutMs,
  })
  await waitForValue(
    abortedCount,
    count => count > 0,
    'Cancelling a running dispatch did not abort the model request',
    modelTimeoutMs
  )
  await capture(control, '04-cancelled-without-status-advance.png')
  releaseModel()
  assert.equal(
    await control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]')),
    'in_progress',
    'Cancelling an execution incorrectly completed or reviewed the Issue'
  )
  await control.command('click', scoped('[data-testid="issue-dispatch-retry"]'))
  await control.command(
    'waitFor',
    scoped('[data-testid^="issue-dispatch-task-activity-"][data-status="succeeded"]'),
    { timeoutMs: modelTimeoutMs }
  )
  assert.equal(
    await control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]')),
    'in_review',
    'Retrying a cancelled direct Agent dispatch did not close the delivery loop'
  )
  await control.command(
    'scrollIntoView',
    scoped('[data-testid^="issue-dispatch-task-activity-"][data-status="succeeded"]')
  )
  await capture(control, '05-retry-succeeded-in-review.png')
}

export function createDesktopScenario({ captureScreenshot, modelResponseTimeoutMs, uiTimeoutMs }) {
  let backendUrl = ''
  let authToken = ''
  let fixture = null
  let fixtureArchived = false
  let holdModel = false
  let releaseResolve = null
  let requestCount = 0
  let abortedRequests = 0
  const release = new Promise(resolve => {
    releaseResolve = resolve
  })

  const request = (pathname, options) => requestJson(backendUrl, authToken, pathname, options)
  const capture = (control, name, selector = ACTIVE_WORKBENCH) =>
    captureScreenshot(control, name, selector)

  async function createFixture(control) {
    const checkpoint = selectedCheckpoint()
    assert.ok(checkpoint, 'Issue Dispatch E2E requires a selected checkpoint')
    const suffix = `${checkpoint}-${process.pid}`
    const owner = await request('/api/users/me')
    const workspaceName = `Issue Dispatch ${suffix}`
    const projectName = `Issue Dispatch Project ${suffix}`
    await openBoard(control, uiTimeoutMs)
    await control.command('click', scoped('[data-testid="collaboration-workspace-create"]'))
    await control.command('waitFor', scoped('[data-testid="collaboration-workspace-name-input"]'), {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('fill', scoped('[data-testid="collaboration-workspace-name-input"]'), {
      value: workspaceName,
    })
    await control.command(
      'fill',
      scoped('[data-testid="collaboration-workspace-description-input"]'),
      { value: `Created through Wework UI for ${checkpoint}.` }
    )
    await control.command(
      'clickWhenEnabled',
      scoped('[data-testid="collaboration-workspace-create-confirm"]'),
      { timeoutMs: uiTimeoutMs }
    )
    const workspace = await waitForValue(
      async () => {
        const values = await request('/api/v1/workspaces')
        return values.items?.find(candidate => candidate.name === workspaceName) ?? null
      },
      Boolean,
      'The Workspace created through Wework UI was not persisted',
      uiTimeoutMs
    )
    await capture(control, '00-fixture-workspace-created.png')

    await control.command('click', scoped('[data-testid="collaboration-workspace-project-create"]'))
    await control.command('click', '[data-testid="collaboration-workspace-project-create-blank"]')
    await control.command('waitFor', scoped('[data-testid="collaboration-project-name-input"]'), {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('fill', scoped('[data-testid="collaboration-project-name-input"]'), {
      value: projectName,
    })
    if (
      [
        'issue-dispatch-agent',
        'issue-dispatch-group-round',
        'issue-dispatch-cancellation',
      ].includes(checkpoint)
    ) {
      await control.command('waitFor', scoped('.collaboration-project-create-collaborator-token'), {
        text: AGENT_NAME,
        timeoutMs: uiTimeoutMs,
      })
    }
    await control.command(
      'clickWhenEnabled',
      scoped('[data-testid="collaboration-project-create-confirm"]'),
      { timeoutMs: uiTimeoutMs }
    )
    const project = await waitForValue(
      async () => {
        const values = await request(`/api/v1/workspaces/${workspace.id}/projects`)
        return values.items?.find(candidate => candidate.name === projectName) ?? null
      },
      Boolean,
      'The Project created through Wework UI was not persisted',
      uiTimeoutMs
    )
    await control.command('waitFor', scoped('[data-testid="collaboration-root"]'), {
      timeoutMs: uiTimeoutMs,
    })
    await capture(control, '00-fixture-project-created.png')

    const agents = await request(`/api/v1/cloud-projects/${project.id}/chat-agents`)
    const agent =
      agents.find(
        candidate =>
          candidate.display_name === AGENT_NAME ||
          candidate.displayName === AGENT_NAME ||
          candidate.name === AGENT_NAME ||
          candidate.name === 'current-device-agent'
      ) ?? null
    if (
      [
        'issue-dispatch-agent',
        'issue-dispatch-group-round',
        'issue-dispatch-cancellation',
      ].includes(checkpoint)
    ) {
      assert.ok(agent?.id, 'The project created through Wework UI has no current-device Agent')
    }
    let group = null
    if (checkpoint === 'issue-dispatch-group-round') {
      const groupName = `混合执行小组-${process.pid}`
      await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
      await control.command(
        'click',
        scoped('[data-testid="collaboration-project-settings-participants"]')
      )
      await control.command(
        'click',
        scoped('[data-testid="collaboration-participants-tab-groups"]')
      )
      await control.command('click', scoped('[data-testid="collaboration-group-open-create"]'))
      await control.command('waitFor', scoped('[data-testid="collaboration-group-form"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', scoped('[data-testid="collaboration-group-name"]'), {
        value: groupName,
      })
      await control.command(
        'click',
        scoped('[data-testid="collaboration-group-create-add-members"]')
      )
      await control.command(
        'click',
        `[data-testid="collaboration-group-create-member-agent-${agent.id}"]`
      )
      await control.command(
        'click',
        `[data-testid="collaboration-group-create-member-human-${owner.id}"]`
      )
      await control.command(
        'click',
        scoped('[data-testid="collaboration-group-create-add-members"]')
      )
      await control.command('click', scoped('[data-testid="collaboration-group-leader"]'))
      await control.command('click', `[data-testid="collaboration-group-leader-human-${owner.id}"]`)
      await control.command(
        'clickWhenEnabled',
        scoped('[data-testid="collaboration-group-create"]'),
        { timeoutMs: uiTimeoutMs }
      )
      group = await waitForValue(
        async () => {
          const values = await request(`/api/v1/cloud-projects/${project.id}/collaboration-groups`)
          return values.items?.find(candidate => candidate.name === groupName) ?? null
        },
        Boolean,
        'The collaboration group created through Wework UI was not persisted',
        uiTimeoutMs
      )
      await capture(control, '00-fixture-group-created.png')
      await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
    }
    const issueTitles = {
      'issue-dispatch-unified-board': `统一模型 Issue-${process.pid}`,
      'issue-dispatch-human': `人员闭环 Issue-${process.pid}`,
      'issue-dispatch-agent': `智能体闭环 Issue-${process.pid}`,
      'issue-dispatch-group-round': `协作小组轮次 Issue-${process.pid}`,
      'issue-dispatch-cancellation': `取消执行 Issue-${process.pid}`,
    }
    const issueTitle = issueTitles[checkpoint]
    await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
    await control.command('waitFor', scoped('[data-testid="cloud-todo-title"]'), {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), {
      value: issueTitle,
    })
    await control.command('fill', scoped('[data-testid="cloud-todo-detail-description"]'), {
      value: `Created through Wework UI for ${checkpoint}.`,
    })
    await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-create-confirm"]'), {
      timeoutMs: uiTimeoutMs,
    })
    const issue = await waitForValue(
      async () => {
        const values = await request(`/api/v1/cloud-projects/${project.id}/loop-items`)
        return values.items?.find(candidate => candidate.title === issueTitle) ?? null
      },
      Boolean,
      'The Issue created through Wework UI was not persisted',
      uiTimeoutMs
    )
    await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
      text: issueTitle,
      timeoutMs: uiTimeoutMs,
    })
    await capture(control, '00-fixture-issue-created.png')
    fixture = { agent, group, issue, owner, project, workspace }
  }

  async function archiveFixture() {
    if (fixtureArchived || !fixture) return
    try {
      const executions = await request(
        `/api/v1/cloud-projects/${fixture.project.id}/executions?include_terminal=true`
      )
      for (const execution of executions.items.filter(
        candidate => !['completed', 'failed', 'cancelled'].includes(candidate.status)
      )) {
        await request(
          `/api/v1/cloud-projects/${fixture.project.id}/executions/${execution.id}/stop`,
          { method: 'POST' }
        )
      }
      const latestProject = await request(`/api/v1/cloud-projects/${fixture.project.id}`)
      if (latestProject.status !== 'archived') {
        await request(
          `/api/v1/cloud-projects/${fixture.project.id}?version=${latestProject.version}`,
          { method: 'DELETE' }
        )
      }
      const latestWorkspace = await request(`/api/v1/workspaces/${fixture.workspace.id}`)
      if (latestWorkspace.status !== 'archived') {
        await request(
          `/api/v1/workspaces/${fixture.workspace.id}?version=${latestWorkspace.version}`,
          {
            method: 'DELETE',
          }
        )
      }
    } finally {
      fixtureArchived = true
    }
  }

  return {
    requiresCloudEnvironment: true,

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      authToken = cloud.authToken
      await request('/api/admin/setup-complete', { method: 'POST' })
    },

    async handleHttp(requestMessage, response, url) {
      if (
        requestMessage.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      ) {
        return false
      }
      const chunks = []
      for await (const chunk of requestMessage) chunks.push(chunk)
      requestCount += 1
      if (selectedCheckpoint() === 'issue-dispatch-cancellation') {
        holdModel = true
        let cancellationObserved = false
        const recordCancellation = () => {
          if (cancellationObserved) return
          cancellationObserved = true
          abortedRequests += 1
        }
        requestMessage.once('aborted', recordCancellation)
        response.once('close', recordCancellation)
        await release
      }
      const responseId = `issue-dispatch-e2e-${requestCount}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(responseId),
          assistantMessage(`${MODEL_COMPLETION} ${requestCount}`),
          responseCompleted(responseId),
        ])
      )
      return true
    },

    async verify(control) {
      await createFixture(control)
      assert.ok(fixture?.issue?.id, 'The real backend Issue Dispatch fixture is missing')
      const checkpoint = selectedCheckpoint()
      try {
        if (checkpoint === 'issue-dispatch-unified-board') {
          await verifyUnifiedBoard(control, uiTimeoutMs, fixture)
        } else if (checkpoint === 'issue-dispatch-human') {
          await verifyHumanDispatch(control, uiTimeoutMs, fixture, capture)
        } else if (checkpoint === 'issue-dispatch-agent') {
          await verifyAgentDispatch(control, uiTimeoutMs, modelResponseTimeoutMs, fixture, capture)
        } else if (checkpoint === 'issue-dispatch-group-round') {
          await verifyGroupRound(control, uiTimeoutMs, modelResponseTimeoutMs, fixture, capture)
        } else if (checkpoint === 'issue-dispatch-cancellation') {
          await verifyCancellation(
            control,
            uiTimeoutMs,
            modelResponseTimeoutMs,
            releaseResolve,
            fixture,
            capture,
            () => abortedRequests
          )
        } else {
          throw new Error(`Unsupported Issue Dispatch checkpoint: ${checkpoint}`)
        }
        await capture(control, `${checkpoint}-verified.png`)
      } finally {
        await archiveFixture()
      }
    },

    async cleanup() {
      await archiveFixture()
    },

    diagnostics() {
      return {
        abortedRequests,
        fixtureArchived,
        holdModel,
        issueId: fixture?.issue?.id ?? null,
        projectId: fixture?.project?.id ?? null,
        requestCount,
        workspaceId: fixture?.workspace?.id ?? null,
      }
    },
  }
}
