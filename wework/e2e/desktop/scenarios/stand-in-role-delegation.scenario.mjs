import assert from 'node:assert/strict'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { accountCommandResult } from '../modules/account-auth-command.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import { selectedToolCall } from '../modules/model-tool-calls.mjs'
import { ACTIVE_WORKBENCH_SELECTOR } from '../modules/shared.mjs'
import {
  shellCommandPollResponse,
  shellCommandResponse,
} from '../modules/shell-command-response.mjs'
import { openStandInSettings } from '../modules/stand-in-profile-navigation.mjs'
import { storyUntil } from '../modules/stand-in-source-story-evidence.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  delegatedTaskResultEvents,
  isReplyPredictionRequest,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectTool,
  toolOutputText,
} from '../modules/response-protocol.mjs'

const USER = 9001
const ROOT = '[data-testid="stand-in-overview"]'
const CHAT = `${ROOT} [data-testid="stand-in-conversation"]`
const EDITOR = `${CHAT} [data-testid="chat-message-input"][contenteditable="true"]`
const CARD = `${CHAT} [data-testid="stand-in-delegated-work"]`
const TOGGLE = `${CARD} [data-testid="stand-in-delegated-work-toggle"]`
const ROW = `${CARD} [data-testid="stand-in-delegated-work-open"]`
const DETAILS = '[data-testid="stand-in-details-open"]'
const POPOVER = '[data-testid="stand-in-details-popover"]'
const ACTIVE = `${POPOVER} [data-testid="stand-in-details-active-delegations"]`
const PANEL_TOGGLE = '[data-testid="stand-in-delegation-panel-toggle"]'
const PANEL = '[data-testid="stand-in-delegation-panel"]'
const ORDINARY_TASK = '核对发布日历'
const ORDINARY_RESULT = '发布日历已核对。'
const REQUEST = '请准备周五的发布方案，核实迁移风险，并交给公告编辑起草公告。'
const AMBIGUOUS = '这次发布有些风险，找合适的角色帮我看看。'
const CLARIFICATION = '整体发布风险由发布工程核对，迁移和回滚由数据库角色核对。你希望先查哪一块？'
const FOLLOW_UP = '发布窗口定在周五下午，我还能继续跟你聊吗？'
const FOLLOW_UP_REPLY = '可以，分工仍在进行。'
const AUDIENCE_QUESTION = '这份发布公告面向哪些读者？'
const AUDIENCE_CALL = 'release-announcement-audience'
const WORKSPACE_WRITE_CALL = 'role-workspace-permission-write'
const READ_ONLY_WRITE_CALL = 'role-readonly-permission-write'
const WORKSPACE_FILE = 'role-workspace-permission.txt'
const READ_ONLY_FILE = 'role-readonly-permission.txt'
const WRITE_ALLOWED = 'ROLE_WORKSPACE_WRITE_ALLOWED'
const WRITE_BLOCKED = 'ROLE_WORKSPACE_WRITE_BLOCKED'
const READ_ONLY_FOLLOW_UP = '请核对这条任务恢复只读后的工作区写入权限。'
const READ_ONLY_RESULT = '已确认只读任务无法直接写入工作区。'
const FINAL = '发布方案已汇总：迁移可回滚，公告草稿已就绪。'
const CANCEL_REQUEST = '请并行核对下次发布窗口和公告读者。'
const DEPENDENCY_REQUEST = '先核对维护窗口，再写一条使用核验结果的通知。'
const PREREQUISITE_BRIEF = '核对维护窗口的确切时间。'
const DEPENDENT_BRIEF = '依据已核验的维护窗口起草通知。'
const PREREQUISITE_RESULT = '维护窗口为周二 15:30 至 16:00。'
const DEPENDENCY_FINAL = '已根据核验结果起草周二维护通知。'
const RETRY_REQUEST = '请分别核验备用环境和通知渠道。'
const RETRY_WORK = [
  { title: '核验备用环境', message: '核验备用环境是否就绪。' },
  { title: '核验通知渠道', message: '核验维护通知渠道是否就绪。' },
]
const RETRY_FINAL = '备用环境和通知渠道均已核验。'
const CANCEL_WORK = [
  { title: '核对下次发布窗口', message: '核对下一次发布的窗口安排，等待排期数据。' },
  { title: '核对公告读者', message: '核对下一次发布公告的读者范围，等待名单数据。' },
]
const roles = [
  { id: 'release-engineering', name: '发布工程', prompt: '核实发布风险' },
  { id: 'release-writing', name: '公告编辑', prompt: '起草发布公告' },
  { id: 'release-database', name: '数据库', prompt: '核实迁移和回滚' },
]
const work = [
  { title: '核实发布风险', message: '核实这次发布的整体风险，必要时请数据库角色协助。' },
  { title: '起草公告', message: '起草周五发布公告，留待主助理汇总。' },
  { title: '核实迁移回滚', message: '检查本次数据库迁移是否支持回滚，并给出核验结论。' },
]

function writeProbe(file) {
  return process.platform === 'win32'
    ? `try { Set-Content -LiteralPath '${file}' -Value '${WRITE_ALLOWED}' -NoNewline -ErrorAction Stop; Write-Output '${WRITE_ALLOWED}' } catch { Write-Output '${WRITE_BLOCKED}' }`
    : `if printf '%s' '${WRITE_ALLOWED}' > '${file}'; then printf '%s\\n' '${WRITE_ALLOWED}'; else printf '%s\\n' '${WRITE_BLOCKED}'; fi`
}

export function createDesktopScenario({
  captureScreenshot,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  resultDir,
  workspacePath,
}) {
  const taskIds = new Map()
  const reported = new Set()
  const waitingModels = new Map()
  const cancellationTasks = new Map()
  const dependencyTasks = new Map()
  const retryTasks = new Map()
  const retryRuns = [0, 0]
  let dependentStarted = false
  let prerequisiteReleased = false
  let writingWorkspace
  let sequence = 0
  const reply = (response, events) => {
    const id = `role-delegation-${++sequence}`
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
  }
  const tool = (body, name, id, args = {}) =>
    mcpToolRequestEvents(body, {
      toolName: name,
      directToolName: `mcp__wework_stand_in__${name}`,
      argumentsValue: args,
      searchCallId: `${id}-discovery`,
      toolCallId: id,
    }).events

  function delegate(body, index) {
    const role = roles[index]
    return tool(body, 'delegate_role_task', role.id, {
      roleId: role.id,
      requestId: role.id,
      ...work[index],
    })
  }

  function readAcceptance(body, index) {
    const role = roles[index]
    if (!requestContainsToolOutput(body, role.id)) return false
    const output = readMcpToolOutput(body, role.id)
    assert.ok(output.startsWith('{'), `The role ${role.name} could not accept its task: ${output}`)
    const result = JSON.parse(output)
    assert.ok(result.taskId && result.success !== false, JSON.stringify(result))
    taskIds.set(role.id, result.taskId)
    return true
  }

  const audienceQuestion = body =>
    selectedToolCall(
      AUDIENCE_CALL,
      selectTool(body, 'request_user_input', {
        questions: [
          {
            header: '公告读者',
            id: 'audience',
            question: AUDIENCE_QUESTION,
            options: [
              { label: '内部团队', description: '为参与发布的同事起草。' },
              { label: '产品用户', description: '为使用产品的用户起草。' },
            ],
          },
        ],
      })
    )

  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname)) {
        return false
      }
      const body = await readRequestBody(request)
      if (
        isReplyPredictionRequest(body) ||
        ['prewarm', 'compaction'].includes(codexRequestKind(body))
      ) {
        return false
      }
      const latest = JSON.stringify(
        (body.input ?? []).filter(item => item.role === 'user').at(-1) ?? ''
      )
      if (latest.includes(READ_ONLY_FOLLOW_UP)) {
        const result = accountCommandResult(body.input, READ_ONLY_WRITE_CALL)
        if (!result) {
          reply(
            response,
            shellCommandResponse(
              body,
              READ_ONLY_WRITE_CALL,
              writeProbe(READ_ONLY_FILE),
              writingWorkspace
            )
          )
        } else if (result.sessionId) {
          reply(response, shellCommandPollResponse(body, result.pollId, result.sessionId))
        } else {
          assert.match(result.output, new RegExp(WRITE_BLOCKED))
          reply(response, [assistantMessage(READ_ONLY_RESULT)])
        }
        return true
      }
      const answer = toolOutputText(body, AUDIENCE_CALL)
      if (answer !== null) {
        assert.deepEqual(JSON.parse(answer), { answers: { audience: { answers: ['内部团队'] } } })
        reply(response, [assistantMessage('面向内部团队的公告草稿已就绪。')])
        return true
      }
      if (latest.includes(work[1].message)) {
        const result = accountCommandResult(body.input, WORKSPACE_WRITE_CALL)
        if (result) {
          if (result.sessionId) {
            reply(response, shellCommandPollResponse(body, result.pollId, result.sessionId))
          } else {
            assert.match(result.output, new RegExp(WRITE_ALLOWED))
            reply(response, audienceQuestion(body))
          }
          return true
        }
      }
      const results = delegatedTaskResultEvents(body)
      if (results) {
        const child = latest.match(/taskId=([^,]+),/)?.[1]
        if (results[0]?.item?.role === 'assistant' && [...retryTasks.values()].includes(child)) {
          const completedRetry = child === retryTasks.get(0) && latest.includes('status=done,')
          if (completedRetry) assert.ok(JSON.stringify(results).includes('备用环境已就绪。'))
          reply(response, completedRetry ? [assistantMessage(RETRY_FINAL)] : [])
          return true
        }
        if (
          results[0]?.item?.role === 'assistant' &&
          [...dependencyTasks.values()].includes(child)
        ) {
          reply(
            response,
            child === dependencyTasks.get(1) ? [assistantMessage(DEPENDENCY_FINAL)] : []
          )
          return true
        }
        if ([...cancellationTasks.values()].includes(child)) {
          reply(response, [])
          return true
        }
        const finalResult = results[0]?.item?.role === 'assistant'
        if (finalResult && [taskIds.get(roles[0].id), taskIds.get(roles[1].id)].includes(child)) {
          assert.equal(
            reported.has(child),
            false,
            'A branch must report only after aggregating its children'
          )
          reported.add(child)
          reply(response, reported.size === 2 ? [assistantMessage(FINAL)] : [])
        } else {
          reply(response, results)
        }
        return true
      }
      if (latest.includes(PREREQUISITE_BRIEF)) {
        waitingModels.set('prerequisite', { response, body })
        return true
      }
      if (latest.includes(DEPENDENT_BRIEF)) {
        assert.equal(
          prerequisiteReleased,
          true,
          'Dependent execution started before its prerequisite'
        )
        assert.ok(
          latest.includes(PREREQUISITE_RESULT),
          'Dependent execution needs the real prerequisite result'
        )
        dependentStarted = true
        reply(response, [assistantMessage('通知草稿已写入周二的准确维护时间。')])
        return true
      }
      if (latest.includes(DEPENDENCY_REQUEST)) {
        for (const [index, item] of [
          { title: '核对维护时间', message: PREREQUISITE_BRIEF },
          { title: '起草维护通知', message: DEPENDENT_BRIEF },
        ].entries()) {
          const id = `dependency-delegation-${index}`
          if (!requestContainsToolOutput(body, id)) {
            reply(
              response,
              tool(body, 'delegate_role_task', id, {
                roleId: roles[index].id,
                requestId: id,
                ...item,
                ...(index === 1 ? { dependsOn: [dependencyTasks.get(0)] } : {}),
              })
            )
            return true
          }
          const result = JSON.parse(readMcpToolOutput(body, id))
          assert.equal(result.accepted, true)
          if (index === 1) assert.equal(result.status, 'waiting_for_dependencies')
          dependencyTasks.set(index, result.taskId)
        }
        reply(response, [assistantMessage('已分派核对和起草，通知会等待核验结果。')])
        return true
      }
      for (const [index, item] of RETRY_WORK.entries()) {
        if (!latest.includes(item.message)) continue
        retryRuns[index] += 1
        if (index === 0 && retryRuns[index] === 1) {
          const id = `role-failure-${++sequence}`
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
          response.end(
            createSse([
              responseCreated(id),
              {
                type: 'response.failed',
                response: {
                  id,
                  status: 'failed',
                  error: {
                    code: 'invalid_prompt',
                    message: 'The model rejected this execution attempt.',
                  },
                },
              },
            ])
          )
        } else if (index === 0) {
          waitingModels.set('retry', { response, body })
        } else {
          reply(response, [assistantMessage('通知渠道已就绪。')])
        }
        return true
      }
      if (latest.includes(RETRY_REQUEST)) {
        for (const [index, item] of RETRY_WORK.entries()) {
          const id = `retry-delegation-${index}`
          if (!requestContainsToolOutput(body, id)) {
            reply(
              response,
              tool(body, 'delegate_role_task', id, {
                roleId: roles[index].id,
                requestId: id,
                ...item,
              })
            )
            return true
          }
          const result = JSON.parse(readMcpToolOutput(body, id))
          assert.equal(result.accepted, true)
          retryTasks.set(index, result.taskId)
        }
        reply(response, [assistantMessage('已分派两项核验。')])
        return true
      }
      for (const [index, work] of CANCEL_WORK.entries()) {
        if (!latest.includes(work.message)) continue
        waitingModels.set(`cancel-${index}`, { response, body })
        return true
      }
      if (latest.includes(CANCEL_REQUEST)) {
        for (const [index, work] of CANCEL_WORK.entries()) {
          const id = `cancel-delegation-${index}`
          if (!requestContainsToolOutput(body, id)) {
            reply(
              response,
              tool(body, 'delegate_role_task', id, {
                roleId: roles[index].id,
                requestId: id,
                ...work,
              })
            )
            return true
          }
          const result = JSON.parse(readMcpToolOutput(body, id))
          assert.equal(result.accepted, true)
          cancellationTasks.set(index, result.taskId)
        }
        reply(response, [assistantMessage('两项核对已分派。')])
        return true
      }
      if (latest.includes(work[1].message) || latest.includes(work[2].message)) {
        const index = latest.includes(work[1].message) ? 1 : 2
        assert.equal(waitingModels.has(index), false, `Role ${index} must start once`)
        waitingModels.set(index, { response, body })
        return true
      }
      if (latest.includes(work[0].message)) {
        reply(
          response,
          readAcceptance(body, 2) ? [assistantMessage('等待数据库核验。')] : delegate(body, 2)
        )
        return true
      }
      if (latest.includes(AMBIGUOUS)) {
        if (!requestContainsToolOutput(body, 'ambiguity-directory')) {
          reply(response, tool(body, 'list_delegate_roles', 'ambiguity-directory'))
        } else {
          const directory = JSON.parse(readMcpToolOutput(body, 'ambiguity-directory')).roles
          assert.ok(directory.some(role => role.id === roles[0].id && role.available))
          assert.ok(directory.some(role => role.id === roles[2].id && role.available))
          reply(response, [assistantMessage(CLARIFICATION)])
        }
        return true
      }
      if (latest.includes(ORDINARY_TASK)) {
        reply(response, [assistantMessage(ORDINARY_RESULT)])
        return true
      }
      if (latest.includes(FOLLOW_UP)) {
        reply(response, [assistantMessage(FOLLOW_UP_REPLY)])
        return true
      }
      if (!latest.includes(REQUEST)) return false
      if (!requestContainsToolOutput(body, 'role-directory')) {
        reply(response, tool(body, 'list_delegate_roles', 'role-directory'))
        return true
      }
      const directory = JSON.parse(readMcpToolOutput(body, 'role-directory')).roles
      assert.ok(
        roles.every(role => directory.some(entry => entry.id === role.id && entry.available))
      )
      reply(
        response,
        !readAcceptance(body, 0)
          ? delegate(body, 0)
          : !readAcceptance(body, 1)
            ? delegate(body, 1)
            : [assistantMessage('已交给发布工程和公告编辑。')]
      )
      return true
    },

    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
      const before = await rpc('runtime.stand_in.personal.get', { userId: USER })
      const catalog = await rpc('runtime.runner.catalog', {})
      const selected = catalog.models.find(model => model.runtime === 'codex' && model.is_default)
      assert.ok(selected, 'A real Codex execution route is required')
      const workspaces = await Promise.all(
        roles.map(async role => {
          const path = join(workspacePath, role.id)
          await mkdir(path, { recursive: true })
          return realpath(path)
        })
      )
      writingWorkspace = workspaces[1]
      for (const [index, role] of roles.entries()) {
        await control.command('seedLocalProject', 'body', {
          value: JSON.stringify({
            projectKey: role.id,
            name: role.name,
            path: workspaces[index],
          }),
        })
      }
      const model = {
        runtime: selected.runtime,
        provider: selected.provider,
        model_id: selected.model_id,
      }
      await rpc('runtime.stand_in.personal.save', {
        userId: USER,
        settings: {
          ...before,
          primary: {
            ...before.primary,
            enabled: true,
            prompt: before.primary?.prompt ?? '',
            preferences: before.primary?.preferences ?? '',
            model,
          },
          roles: roles.map((role, index) => ({
            ...role,
            enabled: true,
            version: 0,
            model,
            executionDeviceId: before.executionDeviceId,
            workspace: {
              projectKey: role.id,
              workspacePath: workspaces[index],
              executionMode: 'current_workspace',
            },
            collaboration: {
              enabled: false,
              allProjects: false,
              projects: [],
              excludedProjects: [],
              tags: [],
            },
          })),
        },
      })
      try {
        await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
        await control.command('waitFor', CHAT)
        await control.command(
          'clickWhenEnabled',
          '[data-testid="stand-in-overview-role-release-writing"]'
        )
        await openStandInSettings(control)
        await control.command('clickWhenEnabled', '[data-testid="stand-in-advanced-open"]')
        const settingsMode =
          '[data-testid="stand-in-task-permissions"] [data-testid="permission-mode-menu-button"]'
        await control.command('clickWhenEnabled', `${settingsMode}[aria-label*="只读"]`)
        await control.command('clickWhenEnabled', '[data-testid="permission-mode-workspace-write"]')
        await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
        await control.command('waitFor', '[data-testid="stand-in-saved"]')
        await control.command('clickWhenEnabled', '[data-testid="stand-in-close"]')
        await control.command('waitFor', '[data-testid="stand-in-profile-panel"]', {
          visible: false,
        })
        await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-open"]')
        await control.command('waitFor', EDITOR)
        const executorLog = join(resultDir, 'executor.log')
        const waitForNativeProfile = (taskId, profile, fromOffset = 0) =>
          storyUntil(
            async () =>
              (await readFile(executorLog, 'utf8'))
                .slice(fromOffset)
                .split('\n')
                .filter(line => line.includes(`codex source sandbox applied task_id=${taskId} `)),
            lines =>
              lines.some(
                line =>
                  line.includes(String.raw`\"id\":\"${profile}\"`) &&
                  line.includes(String.raw`reviewer="\"user\""`)
              ),
            uiTimeoutMs,
            `Task ${taskId} must run with native profile ${profile} and the human reviewer`
          )
        const ordinaryTaskId = 'stand-in-delegation-story-ordinary-task'
        const origin = {
          type: 'stand_in_task',
          initiatedBy: 'stand_in',
          standInId: '@primary',
          userId: USER,
          deviceId: before.executionDeviceId,
        }
        const ordinaryTask = await rpc('runtime.tasks.create', {
          taskId: ordinaryTaskId,
          title: ORDINARY_TASK,
          runtime: 'codex',
          workspacePath,
          message: ORDINARY_TASK,
          origin,
          executionRequest: {
            task_id: ordinaryTaskId,
            subtask_id: ordinaryTaskId,
            user_id: USER,
            prompt: ORDINARY_TASK,
            new_session: true,
            bot: [{ shell_type: 'Codex', name: 'Calendar verification' }],
            model_config: { model_id: model.model_id, model_provider: model.provider },
            origin,
          },
          modelSelection: {
            modelName: model.model_id,
            modelType: 'runtime',
            options: { runnerModelProvider: model.provider },
          },
        })
        assert.equal(ordinaryTask.accepted, true)
        const send = async text => {
          await control.command('fill', EDITOR, { value: text })
          await control.command('clickWhenEnabled', `${CHAT} [data-testid="send-message-button"]`)
        }
        const waitForReply = text =>
          control.command('waitFor', `${CHAT} [data-testid="assistant-message-content"]`, {
            text,
            timeoutMs: modelResponseTimeoutMs,
          })
        let card = CARD
        let toggle = TOGGLE
        let row = ROW
        const readBranches = () =>
          rpc('runtime.stand_in.role_task.branches', {
            userId: USER,
            taskId: 'stand-in-chat-9001-primary',
          })
        const selectDelegation = async taskId => {
          const { items } = await storyUntil(
            readBranches,
            ({ items }) => items.some(branch => branch.taskId === taskId),
            uiTimeoutMs,
            `Delegation group should contain ${taskId}`
          )
          const root = items.find(branch => branch.taskId === taskId).root
          card = `${CARD}[data-delegation-root="${root}"]`
          toggle = `${card} [data-testid="stand-in-delegated-work-toggle"]`
          row = `${card} [data-testid="stand-in-delegated-work-open"]`
        }
        const expandDelegation = async () => {
          if (
            Number(await control.command('getElementCount', `${toggle}[aria-expanded="true"]`)) ===
            0
          ) {
            await control.command('clickWhenEnabled', toggle)
          }
          await control.command('waitFor', `${toggle}[aria-expanded="true"]`, {
            visible: true,
            timeoutMs: uiTimeoutMs,
          })
        }
        await send(AMBIGUOUS)
        await waitForReply(CLARIFICATION)
        assert.equal(taskIds.size, 0)
        assert.equal(Number(await control.command('getElementCount', card)), 0)
        await captureScreenshot(control, '01-role-clarification.png', ROOT)
        await send(REQUEST)
        await control.command('waitFor', card, { timeoutMs: modelResponseTimeoutMs })
        await expandDelegation()
        for (const role of roles) {
          await control.command('waitFor', row, {
            text: role.name,
            timeoutMs: modelResponseTimeoutMs,
          })
        }
        assert.equal(Number(await control.command('getElementCount', row)), 3)
        await control.command('waitFor', toggle, { text: '进行中' })
        await captureScreenshot(control, '02-specialist-branches.png', ROOT)
        await control.command('clickWhenEnabled', DETAILS)
        await control.command('waitFor', ACTIVE, { text: '起草公告', visible: true })
        await control.command('waitFor', ACTIVE, { text: '等待子任务', visible: true })
        await captureScreenshot(control, '02a-active-delegations-in-details.png')
        await control.command('press', POPOVER, { key: 'Escape' })
        await control.command('waitFor', POPOVER, { visible: false })
        await storyUntil(
          () => Promise.resolve(waitingModels.has(1) && waitingModels.has(2)),
          Boolean,
          modelResponseTimeoutMs,
          'Both independent branches must reach their model before either is released'
        )
        await send(FOLLOW_UP)
        await waitForReply(FOLLOW_UP_REPLY)
        await captureScreenshot(control, '03-conversation-remains-available.png', ROOT)
        const timeline = JSON.parse(
          await control.command(
            'getElementMetrics',
            `${CHAT} [data-testid="user-message-content"], ${card}`,
            { value: 'includeText' }
          )
        )
        const requestIndex = timeline.findIndex(element => element.text === REQUEST)
        const followUpIndex = timeline.findIndex(element => element.text === FOLLOW_UP)
        const cardIndex = timeline.findIndex(
          element => element.testId === 'stand-in-delegated-work'
        )
        assert.ok(
          requestIndex >= 0 && requestIndex < cardIndex && cardIndex < followUpIndex,
          `The delegation stays between request and follow-up: request=${requestIndex}, card=${cardIndex}, follow-up=${followUpIndex}`
        )
        reply(waitingModels.get(2).response, [assistantMessage('数据库迁移支持回滚。')])
        const writing = waitingModels.get(1)
        reply(
          writing.response,
          shellCommandResponse(
            writing.body,
            WORKSPACE_WRITE_CALL,
            writeProbe(WORKSPACE_FILE),
            writingWorkspace
          )
        )
        await control.command('waitFor', card, {
          text: AUDIENCE_QUESTION,
          timeoutMs: modelResponseTimeoutMs,
        })
        await control.command(
          'clickWhenEnabled',
          `${card} [data-testid="stand-in-delegated-work-reply"]`
        )
        await captureScreenshot(control, '04-specialist-question-inline.png', ROOT)
        await control.command('clickWhenEnabled', `${card} [data-testid="interaction-answer-0"]`)
        await waitForReply(FINAL)
        await control.command('waitFor', toggle, {
          text: '已完成 3/3',
          timeoutMs: uiTimeoutMs,
        })
        await captureScreenshot(control, '05-result-in-original-chat.png', ROOT)
        await control.command('clickWhenEnabled', DETAILS)
        await control.command('waitFor', POPOVER, { visible: true })
        assert.equal(Number(await control.command('getElementCount', ACTIVE)), 0)
        await captureScreenshot(control, '05a-completed-delegation-out-of-details.png')
        await control.command('press', POPOVER, { key: 'Escape' })
        await control.command('waitFor', POPOVER, { visible: false })
        await control.command('clickWhenEnabled', PANEL_TOGGLE)
        await control.command('waitFor', PANEL, { text: '已完成 3/3', visible: true })
        await control.command('waitFor', `${PANEL} [data-testid="stand-in-sidebar-task"]`, {
          text: ORDINARY_TASK,
          visible: true,
        })
        const activityList = `${PANEL} [data-testid="stand-in-sidebar-activity-list"]`
        await control.command(
          'waitFor',
          `${activityList} > li > [data-testid="stand-in-delegated-work"]`,
          {
            visible: true,
          }
        )
        await control.command(
          'waitFor',
          `${activityList} > li > [data-testid="stand-in-sidebar-task"]`,
          {
            text: ORDINARY_TASK,
            visible: true,
          }
        )
        await captureScreenshot(control, '05b-delegation-and-tasks-panel.png', ROOT)
        await control.command('clickWhenEnabled', PANEL_TOGGLE)
        await control.command('waitFor', PANEL, { visible: false })
        assert.equal(reported.size, 2)
        for (const [index, role] of roles.entries()) {
          const { task } = await rpc('runtime.tasks.get', { taskId: taskIds.get(role.id) })
          assert.equal(task.runtimeHandle.origin.standInId, role.id)
          assert.equal(await realpath(task.workspacePath), workspaces[index])
        }
        const writingTaskId = taskIds.get(roles[1].id)
        await waitForNativeProfile(writingTaskId, ':workspace')
        await waitForNativeProfile(taskIds.get(roles[0].id), 'wework-source-read')
        assert.equal(await readFile(join(writingWorkspace, WORKSPACE_FILE), 'utf8'), WRITE_ALLOWED)
        // A compact viewport can unmount the original request after the result and panel visit.
        await control.command(
          'scrollToRatioAsUser',
          `${CHAT} [data-testid="right-workspace-chat-scroll-area"]`,
          {
            value: '0',
          }
        )
        await control.command('clickElementWithText', row, {
          text: '核实迁移回滚',
          visible: true,
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', '[data-testid="assistant-message-content"]', {
          text: '数据库迁移支持回滚。',
          timeoutMs: uiTimeoutMs,
        })
        await captureScreenshot(control, '06-specialist-task-open.png')

        await control.command('navigate', 'body', { value: '/stand-in' })
        await control.command('waitFor', EDITOR, { visible: true, timeoutMs: uiTimeoutMs })
        await send(CANCEL_REQUEST)
        await waitForReply('两项核对已分派。')
        await storyUntil(
          () => Promise.resolve(waitingModels.has('cancel-0') && waitingModels.has('cancel-1')),
          Boolean,
          modelResponseTimeoutMs,
          'Both specialist executions should start before cancellation'
        )
        await selectDelegation(cancellationTasks.get(0))
        await expandDelegation()
        const branchButton = `${card} [data-testid="stand-in-delegated-work-cancel-branch"][aria-label="取消「核对下次发布窗口」"]`
        const confirm = '[data-testid="stand-in-delegated-work-confirm-cancel"]'
        await control.command('clickWhenEnabled', branchButton, { timeoutMs: uiTimeoutMs })
        await control.command('waitFor', confirm, { visible: true, timeoutMs: uiTimeoutMs })
        await captureScreenshot(control, '07-confirm-branch-cancellation.png')
        await control.command('clickWhenEnabled', confirm, { timeoutMs: uiTimeoutMs })
        const readTask = index => rpc('runtime.tasks.get', { taskId: cancellationTasks.get(index) })
        const cancelled = ({ task }) => task?.status === 'cancelled' && !task.running
        await storyUntil(
          () => readTask(0),
          cancelled,
          uiTimeoutMs,
          'The selected branch should stop'
        )
        assert.equal((await readTask(1)).task.running, true, 'The sibling should keep executing')
        await control.command('waitFor', row, { text: '已取消', timeoutMs: uiTimeoutMs })
        await captureScreenshot(control, '08-cancel-one-branch.png', ROOT)
        await control.command(
          'clickWhenEnabled',
          `${card} [data-testid="stand-in-delegated-work-cancel-all"]`
        )
        await control.command('clickWhenEnabled', confirm, { timeoutMs: uiTimeoutMs })
        await storyUntil(
          () => readTask(1),
          cancelled,
          uiTimeoutMs,
          'Cancel delegation should stop its remaining branch'
        )
        await control.command('waitFor', toggle, {
          text: '委派已取消',
          timeoutMs: uiTimeoutMs,
        })
        await captureScreenshot(control, '09-cancel-delegation.png', ROOT)

        await send(DEPENDENCY_REQUEST)
        await waitForReply('通知会等待核验结果。')
        await selectDelegation(dependencyTasks.get(0))
        await expandDelegation()
        await control.command('waitFor', row, {
          text: '等待前置任务',
          visible: true,
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', `${card} li`, {
          text: '依赖 核对维护时间',
          visible: true,
          timeoutMs: uiTimeoutMs,
        })
        assert.equal(dependentStarted, false)
        await storyUntil(
          () => Promise.resolve(waitingModels.has('prerequisite')),
          Boolean,
          modelResponseTimeoutMs,
          'The prerequisite should start'
        )
        await captureScreenshot(control, '10-wait-for-prerequisite.png', ROOT)
        prerequisiteReleased = true
        reply(waitingModels.get('prerequisite').response, [assistantMessage(PREREQUISITE_RESULT)])
        await waitForReply(DEPENDENCY_FINAL)
        assert.equal(dependentStarted, true)
        await control.command('waitFor', toggle, {
          text: '已完成 2/2',
          timeoutMs: uiTimeoutMs,
        })
        await expandDelegation()
        await captureScreenshot(control, '11-dependency-completed.png', ROOT)
        await send(RETRY_REQUEST)
        await waitForReply('已分派两项核验。')
        await selectDelegation(retryTasks.get(0))
        await control.command('waitFor', toggle, {
          text: '失败',
          timeoutMs: modelResponseTimeoutMs,
        })
        await expandDelegation()
        const retry = `${card} [data-testid="stand-in-delegated-work-retry"]`
        await control.command('waitFor', retry, { text: '重试', timeoutMs: uiTimeoutMs })
        await control.command('waitFor', row, {
          text: '查看详情',
          visible: true,
          timeoutMs: uiTimeoutMs,
        })
        const original = await rpc('runtime.tasks.get', { taskId: retryTasks.get(0) })
        await captureScreenshot(control, '12-failed-branch.png', ROOT)
        await control.command('clickWhenEnabled', retry)
        await storyUntil(
          () => Promise.resolve(waitingModels.has('retry')),
          Boolean,
          modelResponseTimeoutMs,
          'The failed specialist should start again'
        )
        const branches = await readBranches()
        const retried = branches.items.find(branch => branch.taskId === retryTasks.get(0))
        assert.equal(retried.attempt, 1)
        assert.equal(retried.taskAddress.taskId, retryTasks.get(0))
        const resumed = await rpc('runtime.tasks.get', { taskId: retryTasks.get(0) })
        assert.ok(original.task.threadId)
        assert.equal(resumed.task.threadId, original.task.threadId)
        assert.deepEqual(retryRuns, [2, 1])
        await captureScreenshot(control, '13-retrying-same-task.png', ROOT)
        reply(waitingModels.get('retry').response, [assistantMessage('备用环境已就绪。')])
        await waitForReply(RETRY_FINAL)
        await control.command('waitFor', toggle, {
          text: '已完成 2/2',
          timeoutMs: uiTimeoutMs,
        })
        await expandDelegation()
        await captureScreenshot(control, '14-retry-result.png', ROOT)
        const earlier = branches.items.find(branch => branch.taskId === dependencyTasks.get(0))
        const earlierCard = `${PANEL} [data-testid="stand-in-delegated-work"][data-delegation-root="${earlier.root}"]`
        await control.command('clickWhenEnabled', PANEL_TOGGLE)
        const earlierToggle = `${earlierCard} [data-testid="stand-in-delegated-work-toggle"]`
        await control.command('waitFor', earlierToggle, { text: '已完成 2/2', visible: true })
        await control.command('clickWhenEnabled', earlierToggle)
        await control.command(
          'waitFor',
          `${earlierCard} [data-testid="stand-in-delegated-work-open"]`,
          {
            text: '起草维护通知',
            visible: true,
            timeoutMs: uiTimeoutMs,
          }
        )
        await captureScreenshot(control, '15-open-earlier-delegation.png', ROOT)
        await control.command(
          'clickElementWithText',
          `${PANEL} [data-testid="stand-in-sidebar-task"]`,
          {
            text: ORDINARY_TASK,
            visible: true,
            timeoutMs: uiTimeoutMs,
          }
        )
        await control.command('waitFor', '[data-testid="assistant-message-content"]', {
          text: ORDINARY_RESULT,
          timeoutMs: uiTimeoutMs,
        })
        await captureScreenshot(control, '16-ordinary-task-open.png')

        await control.command('navigate', 'body', { value: '/stand-in' })
        await control.command('waitFor', EDITOR, { visible: true, timeoutMs: uiTimeoutMs })
        await control.command(
          'scrollToRatioAsUser',
          `${CHAT} [data-testid="right-workspace-chat-scroll-area"]`,
          { value: '0' }
        )
        await selectDelegation(writingTaskId)
        await expandDelegation()
        await control.command('clickElementWithText', row, {
          text: '起草公告',
          visible: true,
          timeoutMs: uiTimeoutMs,
        })
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`,
          {
            text: '面向内部团队的公告草稿已就绪。',
          }
        )
        const taskMode = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="permission-mode-menu-button"]`
        await control.command('clickWhenEnabled', `${taskMode}[aria-label*="工作区"]`)
        await control.command('clickWhenEnabled', '[data-testid="permission-mode-read-only"]')
        await control.command('waitFor', `${taskMode}[aria-label*="只读"]`)
        const fromOffset = (await readFile(executorLog, 'utf8')).length
        await control.command(
          'fill',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`,
          { value: READ_ONLY_FOLLOW_UP }
        )
        await control.command(
          'clickWhenEnabled',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`
        )
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="assistant-message-content"]`,
          {
            text: READ_ONLY_RESULT,
            timeoutMs: modelResponseTimeoutMs,
          }
        )
        await waitForNativeProfile(writingTaskId, 'wework-source-read', fromOffset)
        await assert.rejects(readFile(join(writingWorkspace, READ_ONLY_FILE)), { code: 'ENOENT' })
        const saved = await rpc('runtime.stand_in.personal.get', { userId: USER })
        assert.equal(
          saved.roles.find(role => role.id === roles[1].id)?.taskPermissions?.permissionMode,
          'workspace-write',
          'Changing one task must leave its role default intact'
        )
      } finally {
        for (const { response } of waitingModels.values()) {
          if (!response.writableEnded) response.end()
        }
      }
    },
  }
}
