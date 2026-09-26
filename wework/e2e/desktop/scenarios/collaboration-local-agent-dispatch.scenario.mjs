import assert from 'node:assert/strict'

import {
  assistantMessage,
  codexRequestKind,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  createLocalCollaborationProject,
  initializeFirstProjectExecutionEnvironment,
  openProjectAgentCreator,
  selectWhenOptionAvailable,
  waitForTestIdByText,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const MODEL = 'wework-custom-desktop-e2e-responses'
const PROJECT = `本地单智能体调度-${process.pid}`
const AGENT = `本地执行智能体-${process.pid}`
const ASSIGNED_TASK = `采集本地执行证据-${process.pid}`
const RENAMED_ISSUE = `已重命名的验证事项-${process.pid}`
const RESULT = `LOCAL_AGENT_RESULT_${process.pid}`
const MARKER = `LOCAL_AGENT_DISPATCH_${process.pid}`
const MANAGEMENT_TOOLS = [
  'get_assignment_candidates',
  'submit_workflow_plan',
  'update_issue_status',
  'report_workflow_outcome',
]

function scoped(selector) {
  return `${CONTENT} ${selector}`
}

function writeEvents(response, responseId, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  response.end(createSse([responseCreated(responseId), ...events, responseCompleted(responseId)]))
}

function advertisedToolNames(body) {
  if (!Array.isArray(body.tools)) return []
  return body.tools
    .map(tool => tool?.name ?? tool?.function?.name ?? '')
    .filter(name => typeof name === 'string' && name)
}

async function addLocalAgent(control, timeoutMs) {
  await control.command('click', scoped('[data-testid="collaboration-tab-manage"]'))
  await control.command(
    'click',
    scoped('[data-testid="collaboration-project-settings-participants"]')
  )
  await control.command('click', scoped('[data-testid="collaboration-participants-tab-agents"]'))
  await openProjectAgentCreator(control, scoped('[data-testid="project-agent-add"]'), timeoutMs)
  await control.command('fill', '[data-testid="cloud-project-chat-agent-display-name"]', {
    value: AGENT,
  })
  await selectWhenOptionAvailable(
    control,
    '[data-testid="cloud-project-chat-agent-model"]',
    MODEL,
    timeoutMs
  )
  await control.command('click', '[data-testid="cloud-project-chat-agent-editor-advanced-toggle"]')
  await control.command('fill', '[data-testid="cloud-project-chat-agent-system-prompt"]', {
    value: `${MARKER}。你是直接执行成员，只完成用户分配的任务，不规划协作小组，不修改 Issue 状态。`,
  })
  await control.command('clickWhenEnabled', '[data-testid="cloud-project-chat-agent-save"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="cloud-project-chat-agent-editor"]', {
    visible: false,
    timeoutMs,
  })
  const agentRow = await waitForTestIdByText(
    control,
    scoped('[data-testid="project-agent-list"]'),
    'project-agent-row-',
    AGENT,
    timeoutMs
  )
  return agentRow.slice('project-agent-row-'.length)
}

async function createIssueAndAssignAgent(control, agentId, timeoutMs) {
  await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
  await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
  await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), {
    value: ASSIGNED_TASK,
  })
  await control.command('fill', scoped('[data-testid="cloud-todo-detail-description"]'), {
    value: `${MARKER}。只读取本地环境并返回 ${RESULT}，不得调用管理类工具。`,
  })
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-create-confirm"]'), {
    timeoutMs,
  })
  await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
    text: ASSIGNED_TASK,
    timeoutMs,
  })
  await control.command('click', scoped('[data-testid="cloud-todo-detail-assignee"]'))
  await control.command(
    'click',
    `[data-testid="cloud-todo-detail-assignee-option-agent:${agentId}"]`
  )
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-save"]'), {
    timeoutMs,
  })
  await control.command('waitFor', scoped('[data-testid="cloud-todo-state-assignee"]'), {
    text: AGENT,
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

async function waitForModelRequest(started, timeoutMs) {
  let timer
  try {
    await Promise.race([
      started,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Direct local Agent did not start a model request')),
          timeoutMs
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function renameIssueWhileRunning(control, timeoutMs) {
  await control.command('fill', scoped('[data-testid="cloud-todo-detail-title"]'), {
    value: RENAMED_ISSUE,
  })
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-save"]'), {
    timeoutMs,
  })
  await control.command('waitFor', scoped('[data-testid="cloud-todo-detail-title"]'), {
    value: RENAMED_ISSUE,
    timeoutMs,
  })
}

async function waitForTestIdPrefix(control, prefix, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = JSON.parse(
      await control.command('snapshot', scoped('[data-testid="cloud-task-activity-list"]'))
    )
    const testId = snapshot.testIds.find(candidate => candidate.startsWith(prefix))
    if (testId) return testId
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.fail(`Unable to find activity element with test id prefix ${prefix}`)
}

export async function createDesktopScenario({
  captureScreenshot,
  modelResponseTimeoutMs,
  uiTimeoutMs,
}) {
  let active = false
  let modelRequests = 0
  let releaseModel
  let resolveModelStarted
  const modelRelease = new Promise(resolve => {
    releaseModel = resolve
  })
  const modelStarted = new Promise(resolve => {
    resolveModelStarted = resolve
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
      const responseId = `local-agent-dispatch-${Date.now()}-${modelRequests}`
      const kind = codexRequestKind(body)
      if (kind === 'prewarm' || kind === 'compaction') {
        writeEvents(response, responseId, [assistantMessage('Ready')])
        return true
      }
      const requestText = JSON.stringify(body)
      if (!requestText.includes(MARKER)) {
        writeEvents(response, responseId, [])
        return true
      }

      modelRequests += 1
      assert.equal(modelRequests, 1, 'Direct Agent assignment started more than one execution')
      assert.ok(
        requestText.includes(ASSIGNED_TASK),
        'Direct Agent request did not contain the title assigned through the Issue UI'
      )
      const toolNames = advertisedToolNames(body)
      for (const toolName of MANAGEMENT_TOOLS) {
        assert.equal(
          toolNames.some(name => name.endsWith(toolName)),
          false,
          `Direct execution Agent was exposed management tool ${toolName}`
        )
      }
      resolveModelStarted()
      await modelRelease
      writeEvents(response, responseId, [
        assistantMessage(`${ASSIGNED_TASK} 已完成。${RESULT}：本地执行证据完整。`),
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
      await initializeFirstProjectExecutionEnvironment(control, CONTENT, uiTimeoutMs)
      const agentId = await addLocalAgent(control, uiTimeoutMs)
      await createIssueAndAssignAgent(control, agentId, uiTimeoutMs)

      await waitForModelRequest(modelStarted, modelResponseTimeoutMs)
      await waitForIssueStatus(control, 'in_progress', modelResponseTimeoutMs)
      await renameIssueWhileRunning(control, uiTimeoutMs)
      await captureScreenshot(control, 'local-agent-dispatch-01-running.png', CONTENT)

      releaseModel()
      await waitForIssueStatus(control, 'in_review', modelResponseTimeoutMs)
      await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
        text: RESULT,
        timeoutMs: modelResponseTimeoutMs,
      })

      const taskSummaryTestId = await waitForTestIdPrefix(
        control,
        'cloud-task-activity-task-summary-',
        modelResponseTimeoutMs
      )
      const taskSummary = await control.command('getText', `[data-testid="${taskSummaryTestId}"]`)
      assert.ok(
        taskSummary.includes(ASSIGNED_TASK),
        'Execution activity did not retain the title assigned when the Agent run started'
      )
      assert.equal(
        taskSummary.includes(RENAMED_ISSUE),
        false,
        'Execution activity incorrectly replaced the assigned task title with the current Issue title'
      )
      assert.equal(
        taskSummary.includes(AGENT),
        false,
        'Execution activity incorrectly used the Agent name as the task title'
      )

      const executionBadgeTestId = await waitForTestIdPrefix(
        control,
        'cloud-task-activity-execution-badge-',
        modelResponseTimeoutMs
      )
      const executionBadge = await control.command(
        'getText',
        `[data-testid="${executionBadgeTestId}"]`
      )
      assert.ok(
        executionBadge.includes('已完成'),
        `Direct Agent activity did not expose its completed execution status: ${executionBadge}`
      )
      assert.equal(
        await control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]')),
        'in_review',
        'Direct Agent completion did not move the Issue to review'
      )
      assert.equal(modelRequests, 1, 'Direct Agent assignment did not complete exactly one run')
      await captureScreenshot(control, 'local-agent-dispatch-02-in-review.png', CONTENT)
    },

    diagnostics() {
      return {
        agent: AGENT,
        assignedTask: ASSIGNED_TASK,
        issue: RENAMED_ISSUE,
        modelRequests,
        project: PROJECT,
      }
    },
  }
}
