import assert from 'node:assert/strict'

import {
  assistantMessage,
  codexRequestKind,
  createSse,
  handleEmptyReplyPrediction,
  mcpToolRequestEvents,
  readRequestBody,
  responseCompleted,
  responseCreated,
  requestContainsToolOutput,
  toolOutputText,
} from '../modules/response-protocol.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  openDirectProjectCreation,
  openProjectAgentCreator,
  configureFirstProjectExecutionEnvironment,
  selectCollaborationDomain,
  selectCloudAgentModel,
  waitForTestIdByText,
} from '../modules/workspace-flows.mjs'
import { REMOTE_DOCKER_DEVICE_ID } from '../modules/shared.mjs'
import { selectCollaborationProjectView } from '../modules/collaboration-project-navigation.mjs'
import { createGuidedReplies } from '../modules/collaboration-guided-replies.mjs'
import {
  assertManagerComment,
  verifyRecordedMemberTranscript,
  assignStoryGroup,
  issueExecution,
  runtimeDeviceId,
  terminalExecution,
  requestJson,
  waitForValue,
  waitForIssueStatus,
  dismissTelemetryConsent,
  waitForCompletedMemberTasks,
  waitForPromise,
  waitForCondition,
  firstRoundPlan,
} from '../modules/collaboration-cloud-story-checks.mjs'
import {
  answerResumedManagerFromIssue,
  createCollaborationIssueReplies,
  managerResumeQuestion,
  updateStatusArguments,
} from '../modules/collaboration-manager-resume-input.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const MODEL = 'desktop-e2e-cloud-responses'
const WORKSPACE = `远程协作调度空间-${process.pid}`
const PROJECT = `远程协作调度项目-${process.pid}`
const LEADER = `远程负责人智能体-${process.pid}`
const COLLECTOR = `远程采集智能体-${process.pid}`
const REVIEWER = `远程复核智能体-${process.pid}`
const GROUP = `远程并发执行小组-${process.pid}`
const ISSUE = `给用户隐私设置增加一个开关-${process.pid}`
const FIRST_TASK = `远程采集运行证据-${process.pid}`
const SECOND_TASK = `远程独立复核结论-${process.pid}`
const MARKER = `REMOTE_GROUP_COORDINATE_${process.pid}`
const MANAGER_REPLY = `${MARKER} 请负责人继续说明最终结论。`
const MANAGER_REPLY_RESULT = '负责人已收到你的回复，并沿用原协作小组会话继续回答。'
const MEMBER_REPLY = `${MARKER} 请采集成员继续检查 CPU。`
const MEMBER_REPLY_RESULT = '采集成员已收到你的回复，并沿用原成员会话继续回答 CPU 情况。'
const SECOND_MEMBER_REPLY = `${MARKER} 请同时核对证据的时间范围。`
const SECOND_MEMBER_REPLY_RESULT = '已单独核对时间范围，采样和结果来自同一窗口。'
const MEMBER_PROGRESS = '准备好了待复核的执行证据。'
const INITIAL_MANAGER_OUTPUT = '第一轮两个任务已交给 Executor 并发执行，等待全部结果。'
const MANAGER_REQUEST_CONTEXT = 'You are the manager for one project Issue.'
const GROUP_RULES = `${MARKER} 协作规则：每轮任务必须独立可验收，全部返回后由负责人评估并显式提交待确认。`
const CALLS = {
  firstPlan: `${MARKER}-plan-1`,
  updateStatus: `${MARKER}-update-status`,
  deliveryRequirements: `${MARKER}-delivery-requirements`,
  createDelivery: `${MARKER}-create-delivery`,
  finalizeDelivery: `${MARKER}-finalize-delivery`,
}

const { scoped, replyToActivity, replyToManagerConclusion } = createCollaborationIssueReplies(
  CONTENT,
  MANAGER_REPLY_RESULT
)

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

function collaborationRequestRole(body) {
  const requestText = JSON.stringify(body)
  if (requestText.includes('任务标题：') && requestText.includes('执行要求：')) return 'member'
  if (requestText.includes(MANAGER_REQUEST_CONTEXT)) return 'manager'

  return null
}

async function createWorkspaceAndProject(control, request, timeoutMs) {
  await control.command('waitFor', scoped('[data-testid="collaboration-workspace-create"]'), {
    timeoutMs,
  })
  await control.command('click', scoped('[data-testid="collaboration-workspace-create"]'))
  await control.command('fill', scoped('[data-testid="collaboration-workspace-name-input"]'), {
    value: WORKSPACE,
  })
  await control.command(
    'clickWhenEnabled',
    scoped('[data-testid="collaboration-workspace-create-confirm"]'),
    { timeoutMs }
  )
  const workspace = await waitForValue(
    async () => (await request('/api/v1/workspaces')).items,
    items => items?.find(item => item.name === WORKSPACE),
    'Wework UI did not persist the remote collaboration workspace',
    timeoutMs
  )

  await openDirectProjectCreation(control, CONTENT)
  await control.command('fill', scoped('[data-testid="collaboration-project-name-input"]'), {
    value: PROJECT,
  })
  await control.command('click', scoped('[data-testid="collaboration-project-create-advanced"]'))
  await control.command('click', scoped('[data-testid="cloud-project-task-provider-local"]'))
  await control.command(
    'clickWhenEnabled',
    scoped('[data-testid="collaboration-project-create-confirm"]'),
    { timeoutMs }
  )
  return waitForValue(
    async () => (await request(`/api/v1/workspaces/${workspace.id}/projects`)).items,
    items => items?.find(item => item.name === PROJECT),
    'Wework UI did not persist the remote collaboration project',
    timeoutMs
  )
}

async function addAgent(control, request, projectId, name, prompt, timeoutMs, environmentId) {
  // Native catalog initialization is a network prerequisite, not a UI step.
  // Establish it before the form starts its own catalog refresh and 10-second waits.
  const environments = await request(
    `/api/v1/resources/execution-environments?project_id=${encodeURIComponent(projectId)}`
  )
  assert.ok(
    environments.some(environment => environment.id === String(environmentId)),
    'The remote execution environment must be authorized before creating its Agent'
  )
  await control.command('click', scoped('[data-testid="collaboration-project-settings-agents"]'))
  await openProjectAgentCreator(
    control,
    scoped('[data-testid="project-agent-add"]'),
    timeoutMs,
    'wework-agent-resource-creator'
  )
  await control.command('fill', '[data-testid="wework-agent-display-name"]', {
    value: name,
  })
  await selectCloudAgentModel(control, request, MODEL, timeoutMs, environmentId)
  await control.command('fill', '[data-testid="wework-agent-system-prompt"]', {
    value: prompt,
  })
  const creatorSnapshot = JSON.parse(
    await control.command('snapshot', '[data-testid="wework-agent-resource-creator"]')
  )
  assert.equal(
    creatorSnapshot.testIds.includes('project-agent-execution-environment'),
    false,
    'Agent editor exposed a local/cloud execution selector instead of using the project runtime'
  )
  await control.command('clickWhenEnabled', '[data-testid="wework-agent-resource-create"]', {
    timeoutMs,
  })
  const agent = await waitForValue(
    () => request(`/api/v1/cloud-projects/${projectId}/chat-agents`),
    agents => agents.find(candidate => candidate.name === name),
    `Wework UI did not persist agent ${name}`,
    timeoutMs
  )
  await control.command('waitFor', '[data-testid="wework-agent-resource-creator"]', {
    visible: false,
    timeoutMs,
  })
  return agent
}

async function createCoordinateGroup(control, request, projectId, timeoutMs) {
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
  const persisted = await waitForValue(
    () => request(`/api/v1/cloud-projects/${projectId}/collaboration-groups`),
    response =>
      response.items?.find(
        candidate => candidate.name === GROUP && candidate.instructions === GROUP_RULES
      ),
    'Wework UI did not persist the collaboration group and its rules',
    timeoutMs
  )
  return {
    id: persisted.id,
    leaderId,
    collectorId: collectorTestId.slice('collaboration-group-create-member-agent-'.length),
    reviewerId: reviewerTestId.slice('collaboration-group-create-member-agent-'.length),
  }
}

async function createIssue(control, request, projectId, timeoutMs) {
  await selectCollaborationProjectView(control, CONTENT, 'board')
  await control.command('clickWhenEnabled', scoped('[data-testid="collaboration-issue-create"]'))
  await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), {
    value: ISSUE,
  })
  await control.command('fill', scoped('[data-testid="cloud-todo-detail-description"]'), {
    value: `${MARKER}。给用户隐私设置增加一个开关。请整理可验收的隐私规则和证据，独立复核风险，并随 Issue 提交交付。`,
  })
  await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-create-confirm"]'), {
    timeoutMs,
  })
  await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
    text: ISSUE,
    timeoutMs,
  })
  return waitForValue(
    async () => (await request(`/api/v1/cloud-projects/${projectId}/loop-items`)).items,
    items => items.find(item => item.title === ISSUE),
    'Wework UI did not persist the collaboration Issue',
    timeoutMs
  )
}

function collaborationGroupAgentId(agent) {
  return agent.wegentTeamId ?? agent.wegent_team_id ?? agent.teamId ?? agent.team_id ?? agent.id
}

async function waitForActivityText(control, text, timeoutMs) {
  await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
    text,
    timeoutMs,
  })
}

export async function createDesktopScenario({
  captureScreenshot,
  modelResponseTimeoutMs,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
  verifyManagerPlanning,
  verifyMemberActivity,
}) {
  let active = false
  let backendUrl = ''
  let authToken = ''
  let cloudEnvironment = null
  let remoteDevice = null
  let project = null
  let rootIssue = null
  let parentStage = 'initial'
  let collectorAgentId = ''
  let reviewerAgentId = ''
  let managerRuns = 0
  let managerReplyRequests = 0
  const guidedReplies = createGuidedReplies({
    marker: MARKER,
    firstQuestion: MEMBER_REPLY,
    firstAnswer: MEMBER_REPLY_RESULT,
    secondQuestion: SECOND_MEMBER_REPLY,
    secondAnswer: SECOND_MEMBER_REPLY_RESULT,
  })
  let childRequests = 0
  let childCompletions = 0
  let releaseFirstChild
  let releaseSecondChild
  let resolveBothChildrenStarted
  let releaseManagerPlanning
  let resolveManagerPlanningStarted
  const managerPlanningRelease = new Promise(resolve => {
    releaseManagerPlanning = resolve
  })
  const managerPlanningStarted = new Promise(resolve => {
    resolveManagerPlanningStarted = resolve
  })
  const firstChildRelease = new Promise(resolve => {
    releaseFirstChild = resolve
  })
  const secondChildRelease = new Promise(resolve => {
    releaseSecondChild = resolve
  })
  const bothChildrenStarted = new Promise(resolve => {
    resolveBothChildrenStarted = resolve
  })
  const request = (pathname, options, deferTranscriptBusy) =>
    requestJson(backendUrl, authToken, pathname, options, deferTranscriptBusy)
  const listComments = () =>
    request(`/api/v1/cloud-projects/${project.id}/loop-items/${rootIssue.id}/activity-comments`)

  return {
    requiresCloudEnvironment: true,

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      authToken = cloud.authToken
      await request('/api/admin/setup-complete', { method: 'POST' })
    },

    setCloudEnvironment(environment) {
      cloudEnvironment = environment
    },

    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      ) {
        return false
      }
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const requestText = JSON.stringify(body)
      const responseId = `remote-group-coordinate-${Date.now()}-${childRequests}`
      const kind = codexRequestKind(body)
      if (kind === 'prewarm' || kind === 'compaction') {
        writeEvents(response, responseId, [assistantMessage('Ready')])
        return true
      }
      if (!requestText.includes(MARKER)) {
        writeEvents(response, responseId, [])
        return true
      }

      const requestRole = collaborationRequestRole(body)
      assert.ok(requestRole, '协作调度请求没有携带明确的 manager/member 请求上下文')
      if (requestRole === 'member') {
        if (requestText.includes(MEMBER_REPLY)) {
          assert.ok(requestText.includes(FIRST_TASK), '成员回复丢失了原分配任务上下文')
          const events = await guidedReplies.modelEvents(
            body,
            requestText,
            { space_id: String(project.id), item_id: rootIssue.id },
            listComments
          )
          writeEvents(response, responseId, events)
          return true
        }
        assert.ok(
          requestText.includes('Delegate a single nontrivial task to one subagent'),
          '成员运行必须收到单个复杂任务默认使用 subagent 的英文指引'
        )
        const childOrdinal = requestText.includes(FIRST_TASK)
          ? 1
          : requestText.includes(SECOND_TASK)
            ? 2
            : 0
        assert.notEqual(childOrdinal, 0, '执行成员请求没有包含负责人分配的任务标题')
        const deliveryCall = Object.values(CALLS)
          .slice(2)
          .some(call => [call, `${call}-search`].some(id => requestContainsToolOutput(body, id)))
        if (!deliveryCall) {
          childRequests += 1
          assert.ok(childRequests <= 2, '纯 AI 小组完成后不应再派发成员任务')
          if (childRequests === 2) resolveBothChildrenStarted()
          await (childOrdinal === 1 ? firstChildRelease : secondChildRelease)
        }
        if (childOrdinal === 1 && !requestContainsToolOutput(body, CALLS.finalizeDelivery)) {
          const scope = { space_id: String(project.id), item_id: rootIssue.id }
          const draft = toolOutputText(body, CALLS.createDelivery)
          const requirements = toolOutputText(body, CALLS.deliveryRequirements)
          const selection = draft
            ? managerToolEvents(body, 'finalize_delivery', CALLS.finalizeDelivery, {
                ...scope,
                delivery_id: JSON.parse(draft).id,
                fulfillments: [],
              })
            : requirements
              ? managerToolEvents(body, 'create_delivery', CALLS.createDelivery, {
                  ...scope,
                  markdown: `# ${FIRST_TASK}\n\n证据完整，已整理待复核。`,
                })
              : managerToolEvents(
                  body,
                  'get_delivery_requirements',
                  CALLS.deliveryRequirements,
                  scope
                )
          writeEvents(response, responseId, selection.events)
          return true
        }
        childCompletions += 1
        const progress = assistantMessage(MEMBER_PROGRESS)
        progress.item.phase = 'commentary'
        writeEvents(response, responseId, [
          ...(childOrdinal === 1 ? [progress] : []),
          assistantMessage(
            childOrdinal === 1
              ? `${FIRST_TASK} 已完成：证据完整。`
              : `${SECOND_TASK} 已完成：复核通过。`
          ),
        ])
        return true
      }

      assert.equal(requestRole, 'manager', '非成员请求没有携带负责人请求上下文')
      if (['complete', 'replied'].includes(parentStage) && requestText.includes(MANAGER_REPLY)) {
        managerReplyRequests += 1
        parentStage = 'replied'
        writeEvents(response, responseId, [assistantMessage(MANAGER_REPLY_RESULT)])
        return true
      }
      if (requestContainsToolOutput(body, CALLS.updateStatus)) {
        parentStage = 'complete'
        writeEvents(response, responseId, [assistantMessage(updateStatusArguments().comment)])
        return true
      }
      if (
        requestContainsToolOutput(body, CALLS.firstPlan) &&
        !requestText.includes('<collaboration_round_results>')
      ) {
        parentStage = 'first-round-dispatched'
        writeEvents(response, responseId, [assistantMessage(INITIAL_MANAGER_OUTPUT)])
        return true
      }

      if (parentStage === 'initial') {
        if (verifyManagerPlanning) {
          resolveManagerPlanningStarted()
          await managerPlanningRelease
        }
        assert.ok(
          JSON.stringify(body.input ?? body.messages ?? '').includes(GROUP_RULES),
          '项目协作规则没有作为负责人本轮用户消息的一部分传入'
        )
        const selection = managerToolEvents(
          body,
          'submit_workflow_plan',
          CALLS.firstPlan,
          firstRoundPlan({
            marker: MARKER,
            firstTask: FIRST_TASK,
            secondTask: SECOND_TASK,
            collectorAgentId,
            reviewerAgentId,
          })
        )
        if (selection.mode === 'direct') {
          managerRuns += 1
          parentStage = 'first-round-dispatched'
        }
        writeEvents(response, responseId, selection.events)
        return true
      }

      if (parentStage === 'first-round-dispatched') {
        assert.ok(requestText.includes(`${FIRST_TASK} 已完成：证据完整。`))
        assert.ok(requestText.includes(`${SECOND_TASK} 已完成：复核通过。`))
        const question = managerResumeQuestion(body)
        if (question) {
          writeEvents(response, responseId, question)
          return true
        }
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
      assert.ok(cloudEnvironment, 'The real cloud environment was not attached to the scenario')
      remoteDevice = await cloudEnvironment.waitForDeviceType(REMOTE_DOCKER_DEVICE_ID, 'remote')
      assert.ok(remoteDevice?.id, 'The real remote Docker Executor device is unavailable')
      active = true
      await ensureExperimentalFeaturesEnabled(control)
      await dismissTelemetryConsent(control, workbenchReadyTimeoutMs)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('waitFor', scoped('[data-testid="collaboration-platform-root"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await selectCollaborationDomain(control, CONTENT, 'cloud')
      project = await createWorkspaceAndProject(control, request, uiTimeoutMs)
      await configureFirstProjectExecutionEnvironment(
        control,
        CONTENT,
        modelResponseTimeoutMs,
        remoteDevice.id
      )

      const leader = await addAgent(
        control,
        request,
        project.id,
        LEADER,
        `${MARKER}。你是负责人，通过 wework_space.submit_workflow_plan 分配独立任务，Executor 在本轮结果到齐后启动新的负责人运行，最终由你显式调用 update_issue_status。`,
        uiTimeoutMs,
        remoteDevice.id
      )
      const collector = await addAgent(
        control,
        request,
        project.id,
        COLLECTOR,
        `${MARKER}。你是执行成员，只完成负责人分配的采集任务并返回证据。`,
        uiTimeoutMs,
        remoteDevice.id
      )
      const reviewer = await addAgent(
        control,
        request,
        project.id,
        REVIEWER,
        `${MARKER}。你是执行成员，只完成负责人分配的复核任务并返回证据。`,
        uiTimeoutMs,
        remoteDevice.id
      )
      const group = await createCoordinateGroup(control, request, project.id, uiTimeoutMs)
      assert.equal(String(group.leaderId), String(collaborationGroupAgentId(leader)))
      assert.equal(String(group.collectorId), String(collaborationGroupAgentId(collector)))
      assert.equal(String(group.reviewerId), String(collaborationGroupAgentId(reviewer)))
      collectorAgentId = group.collectorId
      reviewerAgentId = group.reviewerId
      const creationStartedAt = Date.now()
      rootIssue = await createIssue(control, request, project.id, uiTimeoutMs)
      await assignStoryGroup(control, scoped, group.id, GROUP, uiTimeoutMs)

      if (verifyManagerPlanning) {
        await waitForPromise(
          managerPlanningStarted,
          modelResponseTimeoutMs,
          '远程负责人没有开始规划任务'
        )
        await verifyManagerPlanning(control, {
          groupRules: GROUP_RULES,
          leader: LEADER,
          creationStartedAt,
        })
        releaseManagerPlanning()
      }

      await waitForPromise(
        bothChildrenStarted,
        modelResponseTimeoutMs,
        '分配协作小组后，负责人没有通过 submit_workflow_plan 启动两个并发独立任务'
      )
      const runningDispatch = await waitForValue(
        () => request(`/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`),
        response => {
          const related = response.items.filter(candidate =>
            issueExecution(candidate, rootIssue.id)
          )
          return related.length === 1 &&
            ['claimed', 'running'].includes(related[0].status) &&
            related[0].runtimeTaskId
            ? related[0]
            : null
        },
        'The real remote Executor did not claim the single root group dispatch',
        modelResponseTimeoutMs
      )
      assert.equal(
        runningDispatch.executorType,
        'collaboration_group_dispatch',
        '协作小组根 execution 没有保持单次 Executor handoff'
      )
      assert.equal(
        runtimeDeviceId(runningDispatch),
        REMOTE_DOCKER_DEVICE_ID,
        '协作小组根 execution 没有被远程 Executor claim'
      )
      await waitForIssueStatus(control, scoped, 'in_progress', modelResponseTimeoutMs)
      await waitForActivityText(control, FIRST_TASK, modelResponseTimeoutMs)
      await waitForActivityText(control, SECOND_TASK, modelResponseTimeoutMs)
      await verifyMemberActivity?.(control, {
        backendUrl,
        authToken,
        projectId: project.id,
        issueId: rootIssue.id,
        creationStartedAt,
        phase: 'running',
        timeoutMs: uiTimeoutMs,
      })
      await waitForActivityText(
        control,
        `${LEADER} 将「${FIRST_TASK}」分配给${COLLECTOR}`,
        modelResponseTimeoutMs
      )
      const assignedIssue = await request(`/api/v1/loop-items/${rootIssue.id}`)
      const assignment = assignedIssue.assignment_history.find(
        entry => entry.to_type === 'agent' && entry.to_name === COLLECTOR
      )
      assert.equal(assignment?.by_agent_name, LEADER, '分派记录应显示发起分派的智能体')
      assert.equal(
        await control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]')),
        'in_progress',
        '第一轮执行期间 Issue 没有保持进行中'
      )
      await captureScreenshot(
        control,
        'remote-group-coordinate-01-two-member-tasks-running.png',
        CONTENT
      )

      releaseFirstChild()
      await waitForCondition(
        () => childCompletions,
        value => value === 1,
        modelResponseTimeoutMs,
        '第一个并发子任务没有完成'
      )
      await waitForCompletedMemberTasks(
        control,
        scoped,
        [FIRST_TASK, SECOND_TASK],
        1,
        modelResponseTimeoutMs
      )
      await waitForValue(
        () => request(`/api/v1/loop-items/${rootIssue.id}/deliveries`),
        result =>
          result.items?.find(
            item =>
              item.status === 'delivered' &&
              item.source_task_snapshot?.assignmentId === `${MARKER}-assignment-1`
          ),
        '成员的正式交付应绑定到同一 Issue 和分配',
        modelResponseTimeoutMs
      )
      await waitForActivityText(control, MEMBER_PROGRESS, modelResponseTimeoutMs)
      await waitForActivityText(control, INITIAL_MANAGER_OUTPUT, modelResponseTimeoutMs)
      const comments = await request(
        `/api/v1/cloud-projects/${project.id}/loop-items/${rootIssue.id}/activity-comments`
      )
      assert.deepEqual(
        comments.filter(comment => comment.body === MEMBER_PROGRESS).map(comment => comment.author),
        [COLLECTOR],
        '成员正文应作为一条独立 Issue 评论显示，并使用实际发言的智能体署名'
      )
      await assertManagerComment(
        cloudEnvironment,
        project.id,
        rootIssue.id,
        comments,
        INITIAL_MANAGER_OUTPUT,
        LEADER
      )
      assert.equal(
        await control.command('getValue', scoped('[data-testid="cloud-todo-detail-status"]')),
        'in_progress',
        '只完成一个子任务时 Issue 状态被错误迁移'
      )
      await captureScreenshot(
        control,
        'remote-group-coordinate-02-one-member-task-finished.png',
        CONTENT
      )

      const beforeManagerResume = JSON.parse(
        await control.command('snapshot', scoped('[data-testid="cloud-task-activity-list"]'))
      )
      releaseSecondChild()
      await waitForCompletedMemberTasks(
        control,
        scoped,
        [FIRST_TASK, SECOND_TASK],
        2,
        modelResponseTimeoutMs
      )
      await answerResumedManagerFromIssue({
        control,
        scope: CONTENT,
        leader,
        request,
        issueId: rootIssue.id,
        managerTaskId: `${runningDispatch.runtimeTaskId}-manager-initial`,
        previousManagerEvents: beforeManagerResume.testIds.filter(id =>
          id.startsWith('cloud-task-manager-event-')
        ),
        waitForValue,
        timeoutMs: modelResponseTimeoutMs,
      })
      await waitForIssueStatus(control, scoped, 'in_review', modelResponseTimeoutMs)
      await waitForActivityText(control, '待确认', modelResponseTimeoutMs)
      await waitForActivityText(control, '已完成任务规划', uiTimeoutMs)
      await waitForActivityText(control, '已完成本轮评估', uiTimeoutMs)
      await waitForCondition(
        () => parentStage,
        value => value === 'complete',
        modelResponseTimeoutMs,
        '本轮结果到齐后负责人没有恢复并显式提交待确认'
      )
      assert.equal(managerRuns, 2, '本轮 barrier 后应恰好启动一次新的负责人运行')
      assert.equal(childRequests, 2, '应仅启动最初派发的两个成员任务')
      assert.equal(childCompletions, 2, '两个成员任务都应完成')
      await verifyMemberActivity?.(control, {
        backendUrl,
        authToken,
        projectId: project.id,
        issueId: rootIssue.id,
        creationStartedAt,
        phase: 'completed',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(
        control,
        'remote-group-coordinate-03-agent-owner-awaiting-review.png',
        CONTENT
      )

      const executionResponse = await waitForValue(
        () => request(`/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`),
        response => {
          const related = response.items.filter(candidate =>
            issueExecution(candidate, rootIssue.id)
          )
          return related.length === 1 && related.every(terminalExecution) ? related : null
        },
        'The real remote Executor did not finish the single root group dispatch',
        modelResponseTimeoutMs
      )
      const [dispatch] = executionResponse
      assert.equal(
        dispatch.executorType,
        'collaboration_group_dispatch',
        '协作小组分配没有保持单次 Executor handoff'
      )
      assert.equal(
        runtimeDeviceId(dispatch),
        REMOTE_DOCKER_DEVICE_ID,
        '协作小组 execution 被当前 App 本地 Executor 冒领'
      )
      assert.ok(dispatch.runtimeTaskId, '远程协作根 execution 缺少 Runtime Task')
      const initialManagerTaskId = `${dispatch.runtimeTaskId}-manager-initial`
      const runtimeTask = await cloudEnvironment.runtimeTask(initialManagerTaskId)
      const transcript = await request('/api/runtime-work/transcript', {
        method: 'POST',
        body: JSON.stringify({
          deviceId: runtimeDeviceId(dispatch),
          taskId: dispatch.runtimeTaskId,
          projectSession: { projectId: String(project.id), issueId: rootIssue.id },
        }),
      })
      assert.equal(
        transcript.taskId,
        initialManagerTaskId,
        'Planning details must read the manager session'
      )
      assert.equal(transcript.runtime, 'codex')
      assert.ok(Array.isArray(transcript.turns), 'Planning details must contain canonical turns')
      assert.ok(runtimeTask, `Runtime Task ${initialManagerTaskId} 未由真实 Executor 持久化`)

      await captureScreenshot(
        control,
        'remote-group-coordinate-04-round-awaiting-human-review.png',
        'body'
      )

      const managerConclusionCard = await waitForTestIdByText(
        control,
        CONTENT,
        'cloud-task-activity-card-',
        updateStatusArguments().comment,
        uiTimeoutMs
      )
      const managerTaskId = initialManagerTaskId
      const bindingsBeforeReply = await request(`/api/v1/loop-items/${rootIssue.id}/tasks`)
      assert.ok(
        bindingsBeforeReply.some(binding => binding.task_id === managerTaskId),
        '负责人评估动态没有复用首次分派的会话'
      )
      await replyToManagerConclusion(
        control,
        managerConclusionCard,
        MANAGER_REPLY,
        modelResponseTimeoutMs
      )
      // Closed popup readers retain worker admission until cancellation completes.
      const continuedTranscript = await waitForValue(
        () =>
          request(
            '/api/runtime-work/transcript',
            {
              method: 'POST',
              body: JSON.stringify({
                deviceId: runtimeDeviceId(dispatch),
                taskId: managerTaskId,
              }),
            },
            true
          ),
        Boolean,
        'The continued manager transcript did not regain read admission',
        uiTimeoutMs
      )
      assert.equal(continuedTranscript.taskId, managerTaskId)
      assert.ok(
        JSON.stringify(continuedTranscript.turns).includes(updateStatusArguments().comment),
        'The continued manager session must retain its original conversation'
      )
      assert.ok(JSON.stringify(continuedTranscript.turns).includes(MANAGER_REPLY))
      assert.ok(JSON.stringify(continuedTranscript.turns).includes(MANAGER_REPLY_RESULT))
      assert.equal(managerReplyRequests, 1, '负责人回复被重复执行')
      const bindingsAfterReply = await request(`/api/v1/loop-items/${rootIssue.id}/tasks`)
      assert.deepEqual(
        bindingsAfterReply.map(binding => [binding.device_id, binding.task_id]).sort(),
        bindingsBeforeReply.map(binding => [binding.device_id, binding.task_id]).sort(),
        '负责人回复创建了替代会话'
      )
      await captureScreenshot(control, 'remote-group-coordinate-05-manager-reply.png', 'body')

      const memberTitle = await waitForTestIdByText(
        control,
        CONTENT,
        'cloud-task-activity-task-title-',
        FIRST_TASK,
        uiTimeoutMs
      )
      const memberMessageId = memberTitle.slice('cloud-task-activity-task-title-'.length)
      const memberCard = `cloud-task-activity-card-${memberMessageId}`
      const memberTaskId = `${dispatch.runtimeTaskId}-member-${MARKER}-round-1-${MARKER}-assignment-1`
      const memberBinding = bindingsAfterReply.find(binding => binding.task_id === memberTaskId)
      assert.ok(memberBinding, '成员动态没有绑定实际成员会话')
      await verifyRecordedMemberTranscript({
        request,
        backendUrl,
        projectId: project.id,
        issueId: rootIssue.id,
        memberBinding,
        timeoutMs: uiTimeoutMs,
      })
      const memberLink = scoped(`[data-testid="cloud-task-activity-open-task-${memberMessageId}"]`)
      await control.command('scrollIntoView', scoped(`[data-testid="${memberCard}"]`))
      await control.command('clickWhenEnabled', memberLink, { timeoutMs: uiTimeoutMs })
      const memberPanel = scoped('[data-testid="work-item-task-chat-panel"]')
      await control.command('waitFor', `${memberPanel} [data-testid="message-assistant"]`, {
        text: `${FIRST_TASK} 已完成：证据完整。`,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', scoped('[data-testid="ai-chat-modal-close"]'))
      await control.command('waitFor', memberPanel, { visible: false, timeoutMs: uiTimeoutMs })
      const publicComment = await waitForTestIdByText(
        control,
        CONTENT,
        'cloud-task-activity-card-',
        MEMBER_PROGRESS,
        uiTimeoutMs
      )
      const secondPublicComment = await waitForValue(
        listComments,
        rows => rows.find(row => row.body === `${FIRST_TASK} 已完成：证据完整。`),
        '成员最终答复没有发布成评论',
        modelResponseTimeoutMs
      )
      await guidedReplies.verify({
        control,
        reply: (card, text) => replyToActivity(control, card, text),
        firstCard: publicComment,
        secondCard: `cloud-task-activity-card-${secondPublicComment.id}`,
        executorLog: cloudEnvironment.remoteDockerExecutorRuntimeLogPath,
        memberTaskId,
        listComments,
        timeoutMs: modelResponseTimeoutMs,
      })
      const memberContinuation = await waitForValue(
        () => request(`/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`),
        response =>
          response.items.find(
            candidate =>
              issueExecution(candidate, rootIssue.id) &&
              candidate.runtimeTaskId === memberTaskId &&
              terminalExecution(candidate)
          ),
        '成员回复没有通过真实队列完成原成员会话的续聊',
        modelResponseTimeoutMs
      )
      assert.equal(runtimeDeviceId(memberContinuation), REMOTE_DOCKER_DEVICE_ID)
      assert.equal(childRequests, 2, '成员回复创建了新的协作分配任务')
      assert.equal(managerRuns, 2, '显式续聊不应重新运行协作调度')
      const bindingsAfterMemberReply = await request(`/api/v1/loop-items/${rootIssue.id}/tasks`)
      assert.deepEqual(
        bindingsAfterMemberReply.map(binding => [binding.device_id, binding.task_id]).sort(),
        bindingsAfterReply.map(binding => [binding.device_id, binding.task_id]).sort(),
        '成员回复创建了替代会话'
      )
      await guidedReplies.verifyPublishedSummary(
        control,
        scoped('[data-testid="cloud-task-activity-list"]'),
        listComments,
        uiTimeoutMs
      )
      await captureScreenshot(control, 'remote-group-coordinate-06-member-reply.png', 'body')
    },

    async cleanup() {
      releaseManagerPlanning()
      releaseFirstChild()
      releaseSecondChild()
    },

    diagnostics() {
      return {
        childCompletions,
        childRequests,
        group: GROUP,
        issue: ISSUE,
        managerRuns,
        managerReplyRequests,
        memberReplyNativeTurns: guidedReplies.nativeTurns,
        parentStage,
        projectId: project?.id ?? null,
        remoteDeviceId: remoteDevice?.device_id ?? null,
      }
    },
  }
}
