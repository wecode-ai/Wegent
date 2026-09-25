import assert from 'node:assert/strict'

import { isCollaborationSubagentRequest } from '../modules/subagent-request.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  mcpToolRequestEvents,
  namespacedFunctionCall,
  readRequestBody,
  requestContainsToolOutput,
  requestToolSearchResults,
  responseCompleted,
  responseCreated,
  selectMcpTool,
} from '../modules/response-protocol.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  createLocalCollaborationProject,
  selectWhenOptionAvailable,
  waitForTestIdByText,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const MODEL = 'wework-custom-desktop-e2e-responses'
const PROJECT = `本地协作调度-${process.pid}`
const LEADER = `负责人智能体-${process.pid}`
const MEMBER = `执行智能体-${process.pid}`
const GROUP = `并发执行小组-${process.pid}`
const ISSUE = `核验本地协作调度-${process.pid}`
const FIRST_TASK = '采集运行证据'
const SECOND_TASK = '独立复核结论'
const THIRD_TASK = '补充最终验收证据'
const MARKER = `LOCAL_COORDINATE_${process.pid}`
const GROUP_RULES = `${MARKER} 协作规则：每轮任务必须独立可验收，全部返回后由负责人继续决策。`
const CALLS = {
  firstSpawn: `${MARKER}-spawn-1`,
  secondSpawn: `${MARKER}-spawn-2`,
  firstWait: `${MARKER}-wait-1`,
  secondWait: `${MARKER}-wait-2`,
  thirdSpawn: `${MARKER}-spawn-3`,
  thirdWait: `${MARKER}-wait-3`,
  updateStatus: `${MARKER}-update-status`,
}

function scoped(selector) {
  return `${CONTENT} ${selector}`
}

function writeEvents(response, responseId, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  response.end(createSse([responseCreated(responseId), ...events, responseCompleted(responseId)]))
}

function collaborationTool(body, name, argumentsValue) {
  return selectMcpTool(body, 'collaboration', name, argumentsValue)
}

function updateStatusEvents(body) {
  const searchCallId = `${CALLS.updateStatus}-search`
  const args = {
    idempotency_key: `${MARKER}-final-status`,
    status: 'in_review',
    reason: '第一轮两个并发子任务和第二轮补充任务均已完成，负责人已综合核验。',
  }
  if (requestContainsToolOutput(body, searchCallId)) {
    const namespace = requestToolSearchResults(body).find(
      candidate =>
        candidate?.type === 'namespace' &&
        candidate.name === 'wework_space' &&
        candidate.tools?.some(
          tool => tool?.type === 'function' && tool.name === 'update_issue_status'
        )
    )
    assert.ok(namespace, '负责人未发现 wework_space.update_issue_status')
    const tool = selectMcpTool(body, 'wework_space', 'update_issue_status', args)
    return namespacedFunctionCall(CALLS.updateStatus, tool.namespace, tool.name, tool.arguments)
  }
  return mcpToolRequestEvents(body, {
    toolName: 'update_issue_status',
    argumentsValue: args,
    searchCallId,
    toolCallId: CALLS.updateStatus,
  }).events
}

async function addAgent(control, name, prompt, timeoutMs) {
  await control.command('clickWhenEnabled', scoped('[data-testid="project-agent-add"]'), {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="cloud-project-chat-agent-editor"]', {
    timeoutMs,
  })
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

async function createCoordinateGroup(control, timeoutMs) {
  await control.command('click', scoped('[data-testid="collaboration-participants-tab-groups"]'))
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
    value: `${MARKER}。负责人必须并发分配两个子任务，等待结果后显式更新 Issue 状态。`,
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
    const badges = snapshot.testIds.filter(testId =>
      testId.startsWith('cloud-task-activity-execution-badge-')
    )
    completed = 0
    for (const testId of badges) {
      const text = await control.command('getText', `[data-testid="${testId}"]`)
      if (text.includes('已完成')) completed += 1
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

export async function createDesktopScenario({
  captureScreenshot,
  modelResponseTimeoutMs,
  uiTimeoutMs,
}) {
  let active = false
  let parentStage = 'initial'
  let childRequests = 0
  let childCompletions = 0
  let releaseFirstChild
  let releaseSecondChild
  let releaseThirdChild
  let resolveBothChildrenStarted
  let resolveThirdChildStarted
  const firstChildRelease = new Promise(resolve => {
    releaseFirstChild = resolve
  })
  const secondChildRelease = new Promise(resolve => {
    releaseSecondChild = resolve
  })
  const thirdChildRelease = new Promise(resolve => {
    releaseThirdChild = resolve
  })
  const bothChildrenStarted = new Promise(resolve => {
    resolveBothChildrenStarted = resolve
  })
  const thirdChildStarted = new Promise(resolve => {
    resolveThirdChildStarted = resolve
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
      const responseId = `local-coordinate-${Date.now()}-${childRequests}`
      const kind = codexRequestKind(body)
      if (kind === 'prewarm' || kind === 'compaction') {
        writeEvents(response, responseId, [assistantMessage('Ready')])
        return true
      }
      if (
        !JSON.stringify(body).includes(MARKER) &&
        !isCollaborationSubagentRequest(request.headers)
      ) {
        writeEvents(response, responseId, [])
        return true
      }
      if (isCollaborationSubagentRequest(request.headers)) {
        childRequests += 1
        const childOrdinal = childRequests
        if (childRequests === 2) resolveBothChildrenStarted()
        if (childRequests === 3) resolveThirdChildStarted()
        await (childOrdinal === 1
          ? firstChildRelease
          : childOrdinal === 2
            ? secondChildRelease
            : thirdChildRelease)
        childCompletions += 1
        writeEvents(response, responseId, [
          assistantMessage(
            childOrdinal === 1
              ? `${FIRST_TASK} 已完成：证据完整。`
              : childOrdinal === 2
                ? `${SECOND_TASK} 已完成：复核通过。`
                : `${THIRD_TASK} 已完成：验收证据齐全。`
          ),
        ])
        return true
      }
      if (requestContainsToolOutput(body, CALLS.updateStatus)) {
        parentStage = 'complete'
        writeEvents(response, responseId, [
          assistantMessage('负责人已综合两轮执行结果，并将 Issue 提交待确认。'),
        ])
        return true
      }
      if (requestContainsToolOutput(body, CALLS.thirdWait)) {
        parentStage = 'updating-status'
        writeEvents(response, responseId, updateStatusEvents(body))
        return true
      }
      if (requestContainsToolOutput(body, CALLS.thirdSpawn)) {
        const tool = collaborationTool(body, 'wait_agent', {
          timeout_ms: 60_000,
        })
        parentStage = 'waiting-third'
        writeEvents(response, responseId, [
          ...namespacedFunctionCall(CALLS.thirdWait, tool.namespace, tool.name, tool.arguments),
        ])
        return true
      }
      if (requestContainsToolOutput(body, CALLS.secondWait)) {
        const tool = collaborationTool(body, 'spawn_agent', {
          task_name: 'collect_acceptance_evidence',
          message: `任务标题：${THIRD_TASK}\n${MARKER}。根据第一轮两项结果补充最终验收证据，不修改 Issue 状态。`,
          agent_type: 'wegent_member_1',
          fork_turns: 'none',
        })
        parentStage = 'spawning-third'
        writeEvents(response, responseId, [
          ...namespacedFunctionCall(CALLS.thirdSpawn, tool.namespace, tool.name, tool.arguments),
        ])
        return true
      }
      if (requestContainsToolOutput(body, CALLS.firstWait)) {
        const tool = collaborationTool(body, 'wait_agent', {
          timeout_ms: 60_000,
        })
        parentStage = 'waiting-second'
        writeEvents(response, responseId, [
          ...namespacedFunctionCall(CALLS.secondWait, tool.namespace, tool.name, tool.arguments),
        ])
        return true
      }
      if (requestContainsToolOutput(body, CALLS.secondSpawn)) {
        const tool = collaborationTool(body, 'wait_agent', {
          timeout_ms: 60_000,
        })
        parentStage = 'waiting-first'
        writeEvents(response, responseId, [
          ...namespacedFunctionCall(CALLS.firstWait, tool.namespace, tool.name, tool.arguments),
        ])
        return true
      }
      if (requestContainsToolOutput(body, CALLS.firstSpawn)) {
        const tool = collaborationTool(body, 'spawn_agent', {
          task_name: 'independent_review',
          message: `任务标题：${SECOND_TASK}\n${MARKER}。独立复核第一项工作的目标和证据，不修改 Issue 状态。`,
          agent_type: 'wegent_member_1',
          fork_turns: 'none',
        })
        parentStage = 'spawning-second'
        writeEvents(response, responseId, [
          ...namespacedFunctionCall(CALLS.secondSpawn, tool.namespace, tool.name, tool.arguments),
        ])
        return true
      }
      assert.equal(parentStage, 'initial', `Unexpected manager stage: ${parentStage}`)
      assert.ok(
        JSON.stringify(body.input ?? body.messages ?? '').includes(GROUP_RULES),
        '项目协作规则没有作为负责人本轮用户消息的一部分传入'
      )
      const tool = collaborationTool(body, 'spawn_agent', {
        task_name: 'collect_runtime_evidence',
        message: `任务标题：${FIRST_TASK}\n${MARKER}。采集可复核运行证据，不修改 Issue 状态。`,
        agent_type: 'wegent_member_1',
        fork_turns: 'none',
      })
      parentStage = 'spawning-first'
      writeEvents(response, responseId, [
        ...namespacedFunctionCall(CALLS.firstSpawn, tool.namespace, tool.name, tool.arguments),
      ])
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
        `${MARKER}。你是负责人，必须用 native spawn_agent 并发分配任务，wait 后显式调用 update_issue_status。`,
        uiTimeoutMs
      )
      await addAgent(
        control,
        MEMBER,
        `${MARKER}。你是执行成员，只完成负责人分配的任务并返回证据。`,
        uiTimeoutMs
      )
      await createCoordinateGroup(control, uiTimeoutMs)
      const initialStatus = await createIssueAndAssignGroup(control, uiTimeoutMs)

      await waitForPromise(
        bothChildrenStarted,
        modelResponseTimeoutMs,
        '分配协作小组后，负责人没有通过 native spawn_agent 启动两个并发子任务'
      )
      await waitForActivityText(control, FIRST_TASK, modelResponseTimeoutMs)
      await waitForActivityText(control, SECOND_TASK, modelResponseTimeoutMs)
      await waitForActivityText(
        control,
        `${LEADER} 负责人 · 分配给 ${MEMBER}`,
        modelResponseTimeoutMs
      )
      assert.equal(
        await control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]')),
        initialStatus,
        '子任务完成前 Issue 状态被系统自动迁移'
      )
      await captureScreenshot(control, 'local-coordinate-01-two-member-tasks-running.png', CONTENT)

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
        initialStatus,
        '只完成一个子任务时 Issue 状态被系统自动迁移'
      )
      await captureScreenshot(control, 'local-coordinate-02-one-member-task-finished.png', CONTENT)

      releaseSecondChild()
      await waitForPromise(
        thirdChildStarted,
        modelResponseTimeoutMs,
        '第一轮并发子任务完成后，同一负责人没有继续分配第二轮任务'
      )
      await waitForActivityText(control, THIRD_TASK, modelResponseTimeoutMs)
      await waitForCompletedMemberTasks(control, 2, modelResponseTimeoutMs)
      assert.equal(
        await control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]')),
        initialStatus,
        '第二轮执行完成前 Issue 状态被系统自动迁移'
      )
      assert.equal(parentStage, 'waiting-third', '负责人没有进入第二轮任务等待状态')
      await captureScreenshot(control, 'local-coordinate-03-manager-second-round.png', CONTENT)

      releaseThirdChild()
      await waitForCompletedMemberTasks(control, 3, modelResponseTimeoutMs)
      await waitForIssueStatus(control, 'in_review', modelResponseTimeoutMs)
      await waitForActivityText(control, '待确认', modelResponseTimeoutMs)
      assert.equal(parentStage, 'complete', '负责人未在成员完成后继续运行并完成显式决策')
      assert.equal(childRequests, 3, '负责人没有按两轮启动三个子任务')
      assert.equal(childCompletions, 3, '两轮三个子任务没有全部完成')
      await captureScreenshot(control, 'local-coordinate-04-manager-status-decision.png', CONTENT)
    },

    diagnostics() {
      return {
        childCompletions,
        childRequests,
        group: GROUP,
        issue: ISSUE,
        parentStage,
      }
    },
  }
}
