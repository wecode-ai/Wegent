import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import {
  createLocalCollaborationProject,
  initializeFirstProjectExecutionEnvironment,
  openProjectAgentCreator,
  selectWhenOptionAvailable,
  waitForTestIdByText,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const MODEL = 'wework-custom-desktop-e2e-responses'
const PROJECT = `本地协作取消-${process.pid}`
const LEADER = `取消负责人-${process.pid}`
const MEMBER = `取消执行成员-${process.pid}`
const GROUP = `取消验证小组-${process.pid}`
const ISSUE = `终止负责人执行-${process.pid}`
const MARKER = `LOCAL_GROUP_CANCEL_${process.pid}`
const GROUP_RULES = `${MARKER} 协作规则：负责人必须先规划本轮任务，成员完成后再决定 Issue 状态。`

function scoped(selector) {
  return `${CONTENT} ${selector}`
}

function writeEvents(response, responseId, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  response.end(createSse([responseCreated(responseId), ...events, responseCompleted(responseId)]))
}

async function waitForCondition(read, predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await read()
    if (predicate(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${message}. Last value: ${JSON.stringify(latest)}`)
}

async function addAgent(control, name, prompt, timeoutMs) {
  await openProjectAgentCreator(control, scoped('[data-testid="project-agent-add"]'), timeoutMs)
  await control.command('fill', '[data-testid="cloud-project-chat-agent-display-name"]', {
    value: name,
  })
  await selectWhenOptionAvailable(
    control,
    '[data-testid="cloud-project-chat-agent-model"]',
    MODEL,
    timeoutMs
  )
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

async function createGroup(control, timeoutMs) {
  await control.command('click', scoped('[data-testid="collaboration-participants-tab-groups"]'))
  await control.command('click', scoped('[data-testid="collaboration-group-open-create"]'))
  await control.command('waitFor', scoped('[data-testid="collaboration-group-form"]'), {
    timeoutMs,
  })
  await control.command('fill', scoped('[data-testid="collaboration-group-name"]'), {
    value: GROUP,
  })
  await control.command('fill', scoped('[data-testid="collaboration-group-description"]'), {
    value: '验证用户能从 Issue 动态终止负责人排队中或运行中的本轮执行。',
  })
  await control.command('click', scoped('[data-testid="collaboration-group-create-add-members"]'))
  const leaderMemberTestId = await waitForTestIdByText(
    control,
    'body',
    'collaboration-group-create-member-agent-',
    LEADER,
    timeoutMs
  )
  const memberTestId = await waitForTestIdByText(
    control,
    'body',
    'collaboration-group-create-member-agent-',
    MEMBER,
    timeoutMs
  )
  await control.command('click', `[data-testid="${leaderMemberTestId}"]`)
  await control.command('click', `[data-testid="${memberTestId}"]`)
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
}

async function createIssueAndAssignGroup(control, timeoutMs) {
  await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
  await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
  await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), {
    value: ISSUE,
  })
  await control.command('fill', scoped('[data-testid="cloud-todo-detail-description"]'), {
    value: `${MARKER}。负责人开始规划后，由用户从动态中的停止入口终止本轮执行。`,
  })
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-create-confirm"]'), {
    timeoutMs,
  })
  await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
    text: ISSUE,
    timeoutMs,
  })
  const initialStatus = await control.command(
    'getValue',
    scoped('[data-testid="cloud-todo-detail-status"]')
  )
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
  return initialStatus
}

async function findManagerTestId(control, prefix, timeoutMs) {
  return waitForCondition(
    async () => {
      const snapshot = JSON.parse(
        await control.command('snapshot', scoped('[data-testid="cloud-task-activity-list"]'))
      )
      return snapshot.testIds.find(testId => testId.startsWith(prefix)) ?? null
    },
    Boolean,
    timeoutMs,
    `负责人动态没有出现 ${prefix}`
  )
}

export async function createDesktopScenario({
  captureScreenshot,
  modelResponseTimeoutMs,
  uiTimeoutMs,
}) {
  let active = false
  let managerRequests = 0
  let abortedRequests = 0
  let releaseHeldRequest
  const heldRequestRelease = new Promise(resolve => {
    releaseHeldRequest = resolve
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
      const responseId = `local-group-cancellation-${Date.now()}`
      const kind = codexRequestKind(body)
      if (kind === 'prewarm' || kind === 'compaction') {
        writeEvents(response, responseId, [assistantMessage('Ready')])
        return true
      }
      if (!JSON.stringify(body).includes(MARKER)) {
        writeEvents(response, responseId, [])
        return true
      }
      managerRequests += 1
      assert.ok(
        JSON.stringify(body.input ?? body.messages ?? '').includes(GROUP_RULES),
        '协作规则没有作为负责人本轮用户消息的一部分传入'
      )
      let cancellationObserved = false
      const recordCancellation = () => {
        if (cancellationObserved) return
        cancellationObserved = true
        abortedRequests += 1
        releaseHeldRequest()
      }
      request.once('aborted', recordCancellation)
      response.once('close', recordCancellation)
      await heldRequestRelease
      if (!request.aborted && !response.destroyed) {
        writeEvents(response, responseId, [assistantMessage('请求在测试清理阶段被释放。')])
      }
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
      await initializeFirstProjectExecutionEnvironment(control, CONTENT, uiTimeoutMs)

      await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
      await control.command(
        'click',
        scoped('[data-testid="collaboration-project-settings-participants"]')
      )
      await control.command(
        'click',
        scoped('[data-testid="collaboration-participants-tab-agents"]')
      )
      await addAgent(
        control,
        LEADER,
        `${MARKER}。你是负责人，先规划本轮任务，再委派成员执行。`,
        uiTimeoutMs
      )
      await addAgent(
        control,
        MEMBER,
        `${MARKER}。你是执行成员，只执行负责人分配的任务。`,
        uiTimeoutMs
      )
      await createGroup(control, uiTimeoutMs)
      await createIssueAndAssignGroup(control, uiTimeoutMs)

      const managerEventTestId = await findManagerTestId(
        control,
        'cloud-task-manager-event-',
        modelResponseTimeoutMs
      )
      const managerExecutionTestId = managerEventTestId.replace(
        'cloud-task-manager-event-',
        'cloud-task-manager-execution-'
      )
      await control.command('waitFor', `[data-testid="${managerEventTestId}"]`, {
        text: '正在规划任务',
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('waitFor', `[data-testid="${managerExecutionTestId}"]`, {
        timeoutMs: modelResponseTimeoutMs,
      })
      assert.equal(managerRequests, 1, '协作小组负责人没有启动唯一的一轮规划执行')
      assert.equal(
        await control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]')),
        'in_progress',
        '负责人开始运行后 Issue 没有进入进行中'
      )
      await captureScreenshot(control, 'local-group-cancellation-01-manager-running.png', CONTENT)

      await control.command('click', `[data-testid="${managerExecutionTestId}"]`)
      await control.command('waitFor', '[data-testid="work-item-task-chat-panel"]', {
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="pause-response-button"]', {
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('click', '[data-testid="pause-response-button"]')
      await waitForCondition(
        () => abortedRequests,
        count => count === 1,
        modelResponseTimeoutMs,
        '终止负责人执行后，真实模型请求没有被中断'
      )
      await waitForCondition(
        () => control.command('getText', `[data-testid="${managerEventTestId}"]`),
        text => text.includes('已取消') || text.includes('已停止'),
        modelResponseTimeoutMs,
        '终止负责人执行后，Issue 动态没有显示取消终态'
      )
      await control.command('waitFor', '[data-testid="assistant-stopped-notice"]', {
        text: '已停止',
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="pause-response-button"]', {
        visible: false,
        timeoutMs: modelResponseTimeoutMs,
      })
      assert.equal(
        await control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]')),
        'in_progress',
        '终止负责人执行后 Issue 没有保持进行中'
      )
      await captureScreenshot(control, 'local-group-cancellation-02-manager-cancelled.png', CONTENT)
    },

    async cleanup() {
      releaseHeldRequest()
    },

    diagnostics() {
      return {
        abortedRequests,
        group: GROUP,
        issue: ISSUE,
        managerRequests,
      }
    },
  }
}
