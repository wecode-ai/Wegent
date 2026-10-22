import assert from 'node:assert/strict'

import {
  assistantMessage,
  codexRequestKind,
  createSse,
  mcpToolRequestEvents,
  readRequestBody,
  responseCompleted,
  responseCreated,
  requestContainsToolOutput,
} from '../modules/response-protocol.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  createLocalCollaborationProject,
  configureFirstProjectExecutionEnvironment,
  openProjectAgentCreator,
  selectProjectRunnerModel,
  waitForTestIdByText,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const MODEL = 'local-model:desktop-e2e-responses'
const ALTERNATE_MODEL = 'local-model:desktop-e2e-chat'
const UPSTREAM_MODEL = 'desktop-e2e-responses-model'
const PROJECT = `本地协作调度-${process.pid}`
const LEADER = `负责人智能体-${process.pid}`
const COLLECTOR = `采集智能体-${process.pid}`
const REVIEWER = '当前设备智能体'
const GROUP = `并发执行小组-${process.pid}`
const ISSUE = `核验本地协作调度-${process.pid}`
const HUMAN_ISSUE = `核验本地人工通知-${process.pid}`
const HUMAN_TASK = '人工核验通知与任务入口'
const FIRST_TASK = '采集运行证据'
const SECOND_TASK = '独立复核结论'
const FIRST_INSTRUCTIONS = '采集可复核运行证据，不修改 Issue 状态'
const SECOND_INSTRUCTIONS = '独立复核第一项工作的目标和证据，不修改 Issue 状态'
const MARKER = `LOCAL_COORDINATE_${process.pid}`
const COLLECTOR_ROLE_MARKER = `${MARKER}_COLLECTOR_ROLE`
const REVIEWER_ROLE_MARKER = `${MARKER}_REVIEWER_ROLE`
const GROUP_RULES = `${MARKER} 协作规则：每轮任务必须独立可验收，全部返回后由负责人评估并显式提交待确认。`
const CALLS = {
  firstPlan: `${MARKER}-plan-1`,
  updateStatus: `${MARKER}-update-status`,
  humanPlan: `${MARKER}-human-plan`,
}

function scoped(selector) {
  return `${CONTENT} ${selector}`
}

function writeEvents(response, responseId, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  response.end(createSse([responseCreated(responseId), ...events, responseCompleted(responseId)]))
}

function managerToolEvents(body, toolName, toolCallId, argumentsValue) {
  return mcpToolRequestEvents(body, {
    toolName,
    argumentsValue,
    searchCallId: `${toolCallId}-search`,
    toolCallId,
  })
}

function firstRoundPlan(collectorAgentId, reviewerAgentId) {
  return {
    plan: {
      round_id: `${MARKER}-round-1`,
      summary: '并发采集运行证据并独立复核结论。',
      items: [
        {
          assignment_id: `${MARKER}-assignment-1`,
          title: FIRST_TASK,
          instructions: `${MARKER}。${FIRST_INSTRUCTIONS}。`,
          assignee_type: 'agent',
          assignee_id: collectorAgentId,
        },
        {
          assignment_id: `${MARKER}-assignment-2`,
          title: SECOND_TASK,
          instructions: `${MARKER}。${SECOND_INSTRUCTIONS}。`,
          assignee_type: 'agent',
          assignee_id: reviewerAgentId,
          model_id: MODEL,
        },
      ],
    },
  }
}

function updateStatusArguments() {
  return {
    status: 'in_review',
    reason: '本轮两项成员任务均已完成，负责人已综合核验。',
    comment: '负责人已核验本轮两项任务的执行证据，提交 Issue 待确认。',
  }
}

async function addAgent(control, name, prompt, timeoutMs) {
  await openProjectAgentCreator(control, scoped('[data-testid="project-agent-add"]'), timeoutMs)
  await control.command('fill', '[data-testid="cloud-project-chat-agent-display-name"]', {
    value: name,
  })
  await selectProjectRunnerModel(control, timeoutMs)
  await control.command('click', '[data-testid="cloud-project-chat-agent-editor-advanced-toggle"]')
  await control.command('fill', '[data-testid="cloud-project-chat-agent-system-prompt"]', {
    value: prompt,
  })
  await control.command('clickWhenEnabled', '[data-testid="cloud-project-chat-agent-save"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="cloud-project-chat-agent-editor"]', {
    visible: false,
    timeoutMs,
  })
}

async function configureDefaultDeviceAgent(control, captureScreenshot, timeoutMs) {
  const rowTestId = await waitForTestIdByText(
    control,
    scoped('[data-testid="project-agent-list"]'),
    'project-agent-row-',
    REVIEWER,
    timeoutMs
  )
  const agentId = rowTestId.slice('project-agent-row-'.length)
  await control.command('click', scoped(`[data-testid="project-agent-edit-${agentId}"]`))
  await control.command('click', '[data-testid="cloud-project-chat-agent-editor-tab-runtime"]')
  await control.command('waitFor', '[data-testid="cloud-project-chat-agent-models"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="cloud-project-chat-agent-models"]', {
    text: 'Desktop E2E Responses',
    timeoutMs,
  })
  await control.command('click', `[data-testid="cloud-project-chat-agent-model-${MODEL}"]`)
  await control.command(
    'click',
    `[data-testid="cloud-project-chat-agent-model-${ALTERNATE_MODEL}"]`
  )
  await control.command(
    'scrollIntoView',
    `[data-testid="cloud-project-chat-agent-model-${ALTERNATE_MODEL}"]`
  )
  await control.command('click', '[data-testid="cloud-project-chat-agent-editor-tab-basic"]')
  await control.command('fill', '[data-testid="cloud-project-chat-agent-system-prompt"]', {
    value: `${REVIEWER_ROLE_MARKER}。你是当前设备上的执行成员，只完成负责人分配的复核任务并返回证据。`,
  })
  await captureScreenshot(
    control,
    'local-coordinate-01-default-device-model-range.png',
    '[data-testid="cloud-project-chat-agent-editor"]'
  )
  await control.command('clickWhenEnabled', '[data-testid="cloud-project-chat-agent-save"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="cloud-project-chat-agent-editor"]', {
    visible: false,
    timeoutMs,
  })
  return agentId
}

async function createCoordinateGroup(control, timeoutMs) {
  await control.command('click', scoped('[data-testid="collaboration-project-settings-groups"]'))
  await control.command('click', scoped('[data-testid="collaboration-group-open-create"]'))
  await control.command('waitFor', scoped('[data-testid="collaboration-group-form"]'), {
    timeoutMs,
  })
  await control.command('fill', scoped('[data-testid="collaboration-group-name"]'), {
    value: GROUP,
  })
  await control.command('fill', scoped('[data-testid="collaboration-group-description"]'), {
    value: '用于验证负责人并发委派、汇总结果和显式更新 Issue 状态。',
  })
  await control.command('click', scoped('[data-testid="collaboration-group-create-add-members"]'))
  const leaderMemberTestId = await waitForTestIdByText(
    control,
    'body',
    'collaboration-group-create-member-agent-',
    LEADER,
    timeoutMs
  )
  const collectorTestId = await waitForTestIdByText(
    control,
    'body',
    'collaboration-group-create-member-agent-',
    COLLECTOR,
    timeoutMs
  )
  const reviewerTestId = await waitForTestIdByText(
    control,
    'body',
    'collaboration-group-create-member-agent-',
    REVIEWER,
    timeoutMs
  )
  await control.command('click', `[data-testid="${leaderMemberTestId}"]`)
  await control.command('click', `[data-testid="${collectorTestId}"]`)
  await control.command('click', `[data-testid="${reviewerTestId}"]`)
  const candidates = JSON.parse(await control.command('snapshot', 'body'))
  const humanTestIds = candidates.testIds.filter(testId =>
    testId.startsWith('collaboration-group-create-member-human-')
  )
  assert.equal(humanTestIds.length, 1, 'The local group must expose its current human member')
  const humanSelector = `[data-testid="${humanTestIds[0]}"]`
  if (
    (await control.command('getAttribute', humanSelector, { value: 'aria-pressed' })) !== 'true'
  ) {
    await control.command('click', humanSelector)
  }
  await control.command('click', scoped('[data-testid="collaboration-group-create-add-members"]'))
  await control.command('click', scoped('[data-testid="collaboration-group-leader"]'))
  const leaderId = leaderMemberTestId.slice('collaboration-group-create-member-agent-'.length)
  await control.command('click', `[data-testid="collaboration-group-leader-agent-${leaderId}"]`)
  await control.command('clickWhenEnabled', scoped('[data-testid="collaboration-group-create"]'), {
    timeoutMs,
  })
  await control.command('waitFor', scoped('[data-testid^="collaboration-group-detail-"]'), {
    text: GROUP,
    timeoutMs,
  })
  await control.command('click', scoped('[data-testid="collaboration-group-detail-tab-rules"]'))
  await control.command('fill', scoped('[data-testid="collaboration-group-detail-instructions"]'), {
    value: GROUP_RULES,
  })
  await control.command(
    'clickWhenEnabled',
    scoped('[data-testid="collaboration-group-detail-save"]'),
    { timeoutMs }
  )
  await control.command(
    'waitFor',
    scoped('[data-testid="collaboration-group-detail-instructions"]'),
    {
      value: GROUP_RULES,
      timeoutMs,
    }
  )
  return {
    leaderId,
    collectorId: collectorTestId.slice('collaboration-group-create-member-agent-'.length),
    reviewerId: reviewerTestId.slice('collaboration-group-create-member-agent-'.length),
    humanId: humanTestIds[0].slice('collaboration-group-create-member-human-'.length),
  }
}

async function createIssueAndAssignGroup(control, timeoutMs, title = ISSUE) {
  await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
  await control.command('clickWhenEnabled', scoped('[data-testid="collaboration-issue-create"]'))
  await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), {
    value: title,
  })
  await control.command('fill', scoped('[data-testid="cloud-todo-detail-description"]'), {
    value: `${MARKER}。负责人必须并发分配两个子任务，等待结果后显式更新 Issue 状态。`,
  })
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-create-confirm"]'), {
    timeoutMs,
  })
  await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
    text: title,
    timeoutMs,
  })
  await control.command('click', scoped('[data-testid="cloud-todo-detail-assignee"]'))
  const groupOption = await waitForTestIdByText(
    control,
    'body',
    'cloud-todo-detail-assignee-option-group:',
    GROUP,
    timeoutMs
  )
  await control.command('click', `[data-testid="${groupOption}"]`)
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-save"]'), {
    timeoutMs,
  })
  await control.command('waitFor', scoped('[data-testid="cloud-todo-state-assignee"]'), {
    text: GROUP,
    timeoutMs,
  })
}

async function waitForActivityText(control, text, timeoutMs) {
  await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
    text,
    timeoutMs,
  })
}

async function waitForIssueStatus(control, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]'))
    if (latest === expected) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.fail(`Issue status did not become ${expected}. Last value: ${latest}`)
}

async function waitForCompletedMemberTasks(control, expected, timeoutMs) {
  const activity = scoped('[data-testid="cloud-task-activity-list"]')
  const deadline = Date.now() + timeoutMs
  let completed = 0
  while (Date.now() < deadline) {
    const snapshot = JSON.parse(await control.command('snapshot', activity))
    const taskSummaryTestIds = snapshot.testIds.filter(testId =>
      testId.startsWith('cloud-task-activity-task-summary-')
    )
    completed = 0
    for (const taskSummaryTestId of taskSummaryTestIds) {
      const activityId = taskSummaryTestId.slice('cloud-task-activity-task-summary-'.length)
      const title = await control.command(
        'getText',
        scoped(`[data-testid="cloud-task-activity-task-title-${activityId}"]`)
      )
      if (![FIRST_TASK, SECOND_TASK].includes(title.trim())) continue
      const badgeTestId = `cloud-task-activity-execution-badge-${activityId}`
      if (!snapshot.testIds.includes(badgeTestId)) continue
      const badge = await control.command('getText', `[data-testid="${badgeTestId}"]`)
      if (badge.includes('已完成')) completed += 1
    }
    if (completed === expected) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.fail(`Expected ${expected} completed member tasks, received ${completed}`)
}

async function waitForPromise(promise, timeoutMs, message) {
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

async function waitForCondition(read, predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = read()
    if (predicate(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}. Last value: ${JSON.stringify(latest)}`)
}

async function waitForHumanNotification(control, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let notifications = []
  while (Date.now() < deadline) {
    notifications = JSON.parse(await control.command('getSystemNotifications', 'body'))
    const matches = notifications.filter(notification => notification.body.includes(HUMAN_TASK))
    if (matches.length) {
      assert.equal(matches.length, 1, 'A human assignment must emit exactly one notification')
      return matches[0]
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`Human assignment produced no global notification: ${JSON.stringify(notifications)}`)
}

export async function createDesktopScenario({
  captureScreenshot,
  modelResponseTimeoutMs,
  uiTimeoutMs,
}) {
  let active = false
  let parentStage = 'initial'
  let collectorAgentId = ''
  let reviewerAgentId = ''
  let humanUserId = ''
  let humanNotificationUrl = null
  let releaseHumanDispatch
  let resolveHumanManagerStarted
  const humanDispatchRelease = new Promise(resolve => {
    releaseHumanDispatch = resolve
  })
  const humanManagerStarted = new Promise(resolve => {
    resolveHumanManagerStarted = resolve
  })
  let managerRuns = 0
  let childRequests = 0
  let childCompletions = 0
  let releaseFirstChild
  let releaseSecondChild
  let resolveBothChildrenStarted
  const firstChildRelease = new Promise(resolve => {
    releaseFirstChild = resolve
  })
  const secondChildRelease = new Promise(resolve => {
    releaseSecondChild = resolve
  })
  const bothChildrenStarted = new Promise(resolve => {
    resolveBothChildrenStarted = resolve
  })

  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      ) {
        return false
      }
      const body = await readRequestBody(request)
      const requestText = JSON.stringify(body)
      const responseId = `local-coordinate-${Date.now()}-${childRequests}`
      const kind = codexRequestKind(body)
      if (kind === 'prewarm' || kind === 'compaction') {
        writeEvents(response, responseId, [assistantMessage('Ready')])
        return true
      }
      if (!requestText.includes(MARKER)) {
        writeEvents(response, responseId, [])
        return true
      }

      if (requestText.includes(HUMAN_ISSUE)) {
        if (requestContainsToolOutput(body, CALLS.humanPlan)) {
          writeEvents(response, responseId, [assistantMessage('已分配给人工成员，等待其交付。')])
          return true
        }
        const selection = managerToolEvents(body, 'submit_workflow_plan', CALLS.humanPlan, {
          plan: {
            round_id: `${MARKER}-human-round`,
            summary: '由人工成员核验本地通知和任务入口。',
            items: [
              {
                assignment_id: `${MARKER}-human-assignment`,
                title: HUMAN_TASK,
                instructions: `${MARKER}。${HUMAN_TASK}。`,
                assignee_type: 'human',
                assignee_id: humanUserId,
              },
            ],
          },
        })
        if (selection.mode === 'direct') {
          resolveHumanManagerStarted()
          await humanDispatchRelease
        }
        writeEvents(response, responseId, selection.events)
        return true
      }

      const isCollectorRequest = requestText.includes(COLLECTOR_ROLE_MARKER)
      const isReviewerRequest = requestText.includes(REVIEWER_ROLE_MARKER)
      const isMemberRequest = isCollectorRequest || isReviewerRequest
      if (isMemberRequest) {
        childRequests += 1
        const childOrdinal = requestText.includes(`任务标题：${FIRST_TASK}`)
          ? 1
          : requestText.includes(`任务标题：${SECOND_TASK}`)
            ? 2
            : 0
        assert.notEqual(childOrdinal, 0, '执行成员请求没有包含负责人分配的任务标题')
        if (isReviewerRequest) {
          assert.equal(
            body.model,
            UPSTREAM_MODEL,
            '负责人没有从当前设备智能体预配置的可用模型中选择 Responses 模型'
          )
        }
        if (childRequests === 2) resolveBothChildrenStarted()
        await (childOrdinal === 1 ? firstChildRelease : secondChildRelease)
        childCompletions += 1
        writeEvents(response, responseId, [
          assistantMessage(
            childOrdinal === 1
              ? `${FIRST_TASK} 已完成：证据完整。`
              : `${SECOND_TASK} 已完成：复核通过。`
          ),
        ])
        return true
      }

      assert.ok(
        requestText.includes(GROUP_RULES),
        '协作调度请求既不是负责人运行，也不是执行成员运行'
      )
      if (requestContainsToolOutput(body, CALLS.updateStatus)) {
        parentStage = 'complete'
        writeEvents(response, responseId, [assistantMessage(updateStatusArguments().comment)])
        return true
      }
      if (requestContainsToolOutput(body, CALLS.firstPlan)) {
        parentStage = 'first-round-dispatched'
        writeEvents(response, responseId, [
          assistantMessage('第一轮两个任务已交给 Executor 并发执行，等待全部结果。'),
        ])
        return true
      }

      if (parentStage === 'initial') {
        assert.ok(
          JSON.stringify(body.input ?? body.messages ?? '').includes(GROUP_RULES),
          '项目协作规则没有作为负责人本轮用户消息的一部分传入'
        )
        const selection = managerToolEvents(
          body,
          'submit_workflow_plan',
          CALLS.firstPlan,
          firstRoundPlan(collectorAgentId, reviewerAgentId)
        )
        if (selection.mode === 'direct') {
          managerRuns += 1
          parentStage = 'first-round-dispatched'
        }
        writeEvents(response, responseId, selection.events)
        return true
      }

      if (parentStage === 'first-round-dispatched') {
        assert.equal(requestContainsToolOutput(body, CALLS.firstPlan), false)
        assert.equal(
          requestText.includes(CALLS.firstPlan),
          false,
          '负责人必须使用新会话，不能复用上一轮工具历史'
        )
        assert.ok(requestText.includes(`${FIRST_TASK} 已完成：证据完整。`))
        assert.ok(requestText.includes(`${SECOND_TASK} 已完成：复核通过。`))
        const selection = managerToolEvents(
          body,
          'update_issue_status',
          CALLS.updateStatus,
          updateStatusArguments()
        )
        if (selection.mode === 'direct') {
          managerRuns += 1
          parentStage = 'updating-status'
        }
        writeEvents(response, responseId, selection.events)
        return true
      }

      assert.fail(`Unexpected manager stage: ${parentStage}`)
      return true
    },

    async verify(control) {
      active = true
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, CONTENT, PROJECT)
      await configureFirstProjectExecutionEnvironment(control, CONTENT, uiTimeoutMs)

      await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))

      await control.command(
        'click',
        scoped('[data-testid="collaboration-project-settings-agents"]')
      )
      await addAgent(
        control,
        LEADER,
        `${MARKER}。你是负责人，每轮必须通过 wework_space.submit_workflow_plan 分配独立任务；Executor 在整轮 barrier 后启动新的负责人运行，最终由你显式调用 update_issue_status。`,
        uiTimeoutMs
      )
      await addAgent(
        control,
        COLLECTOR,
        `${COLLECTOR_ROLE_MARKER}。你是执行成员，只完成负责人分配的采集任务并返回证据。`,
        uiTimeoutMs
      )
      await configureDefaultDeviceAgent(control, captureScreenshot, uiTimeoutMs)
      const group = await createCoordinateGroup(control, uiTimeoutMs)
      collectorAgentId = group.collectorId
      reviewerAgentId = group.reviewerId
      humanUserId = group.humanId
      await captureScreenshot(control, 'local-coordinate-02-default-device-in-group.png', CONTENT)
      await createIssueAndAssignGroup(control, uiTimeoutMs)

      await waitForPromise(
        bothChildrenStarted,
        modelResponseTimeoutMs,
        '分配协作小组后，负责人没有通过 submit_workflow_plan 启动两个并发独立任务'
      )
      await waitForIssueStatus(control, 'in_progress', modelResponseTimeoutMs)
      await waitForActivityText(control, FIRST_TASK, modelResponseTimeoutMs)
      await waitForActivityText(control, SECOND_TASK, modelResponseTimeoutMs)
      const assignmentEventTestId = await waitForTestIdByText(
        control,
        scoped('[data-testid="cloud-task-activity-list"]'),
        'cloud-task-manager-event-',
        `${LEADER} 负责人 · 分配任务：`,
        modelResponseTimeoutMs
      )
      const assignmentEvent = await control.command(
        'getText',
        `[data-testid="${assignmentEventTestId}"]`
      )
      assert.ok(assignmentEvent.includes(COLLECTOR), '第一轮分配动态缺少采集智能体')
      assert.ok(assignmentEvent.includes(REVIEWER), '第一轮分配动态缺少复核智能体')
      assert.equal(
        await control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]')),
        'in_progress',
        '第一轮执行期间 Issue 没有保持进行中'
      )
      await captureScreenshot(control, 'local-coordinate-03-two-member-tasks-running.png', CONTENT)

      releaseFirstChild()
      await waitForCondition(
        () => childCompletions,
        value => value === 1,
        modelResponseTimeoutMs,
        '第一个并发子任务没有完成'
      )
      await waitForCompletedMemberTasks(control, 1, modelResponseTimeoutMs)
      assert.equal(
        await control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]')),
        'in_progress',
        '只完成一个子任务时 Issue 状态被错误迁移'
      )
      await captureScreenshot(control, 'local-coordinate-04-one-member-task-finished.png', CONTENT)

      releaseSecondChild()
      await waitForCompletedMemberTasks(control, 2, modelResponseTimeoutMs)
      await waitForIssueStatus(control, 'in_review', modelResponseTimeoutMs)
      await waitForCondition(
        () => parentStage,
        value => value === 'complete',
        modelResponseTimeoutMs,
        '本轮结果到齐后负责人没有恢复并显式提交待确认'
      )
      assert.equal(managerRuns, 2, '本轮 barrier 后应恰好启动一次新的负责人运行')
      assert.equal(childRequests, 2, '应仅启动最初派发的两个成员任务')
      assert.equal(childCompletions, 2, '两个成员任务都应完成')
      await captureScreenshot(
        control,
        'local-coordinate-05-agent-owner-awaiting-review.png',
        CONTENT
      )

      await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
      await createIssueAndAssignGroup(control, uiTimeoutMs, HUMAN_ISSUE)
      await waitForPromise(
        humanManagerStarted,
        modelResponseTimeoutMs,
        'The local coordinator did not prepare a human assignment'
      )
      await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
      await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('clearSystemNotifications', 'body')
      releaseHumanDispatch()
      const notification = await waitForHumanNotification(control, modelResponseTimeoutMs)
      humanNotificationUrl = notification.url
      assert.match(humanNotificationUrl, /^wework:\/\/boards\/local\/[^/]+\/issues\/[^/]+$/)
      await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('activateSystemNotification', 'body', { value: humanNotificationUrl })
      await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
        text: HUMAN_ISSUE,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', scoped('[data-testid="cloud-todo-personal-task-start"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(
        control,
        'local-coordinate-07-human-notification-opened-issue.png',
        CONTENT
      )
    },

    diagnostics() {
      return {
        childCompletions,
        childRequests,
        group: GROUP,
        issue: ISSUE,
        managerRuns,
        parentStage,
        humanNotificationUrl,
      }
    },
  }
}
