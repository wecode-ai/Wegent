import { standInRoleFixture } from '../modules/stand-in-role-fixture.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import {
  assistantMessage,
  createSse,
  delegatedTaskResultEvents,
  isReplyPredictionRequest,
  mcpToolRequestEvents,
  modelMessageText,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectedToolCall,
  selectShellToolCommand,
} from '../modules/response-protocol.mjs'
import { issueCommentFormSelector } from '../modules/issue-comment-selectors.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { storyUntil } from '../modules/stand-in-source-story-evidence.mjs'
import { createIssueDelegationModel } from '../modules/issue-delegation-model.mjs'

const MARKER = `ISSUE_DELEGATION_${process.pid}`
const ROLE = 'issue-delegation-worker'
const ACK = '收到，我会检查后给出结果。'
const RESULT = '已修复计算逻辑。测试验证输入 9 得到 18。'
const PRIVATE = `${MARKER}_PRIVATE_WORKER_EVIDENCE`
const SIMPLE = '这里只需一句简短解释。'
const ANSWER = '这是检查结果的简短解释。'
const EXAMPLES = JSON.parse(
  readFileSync(new URL('../../../src/i18n/locales/zh-CN/common.json', import.meta.url), 'utf8')
).standIn.welcome.examples
const DEVELOPMENT_PROMPT = EXAMPLES.development.prompt
const QUOTE_QUESTION = '请确认需要跟进的项目事项、时区和提醒时间。'
const QUOTE_SCOPE = '报价跟进范围确认：'
const QUOTE_WORK = '核对采购事项的新版报价和交付周期'
const QUOTE_FACTS = '旧版总价 20000 元，交期 14 天。新版总价 18000 元，交期 10 天。'
const QUOTE_RESULT = '新版报价已收到：总价减少 2000 元，交期缩短 4 天。'
const SETUP_QUESTION = '请确认开发助理要接收的项目、任务标签、仓库和执行设备。'
const ROLE_NAME = 'AI 开发助理'
const FILE = 'assigned-issue-fix.cjs'
const BAD_SOURCE = 'module.exports = (value) => value + 1\n'
const FIXED_SOURCE = 'module.exports = (value) => value * 2\n'
const TESTED = 'ASSIGNED_DEVELOPMENT_TEST_PASS'

/** Ordinary assignments delegate without a user asking for subagents. */
export function createDesktopScenario({ uiTimeoutMs, modelResponseTimeoutMs, workspacePath }) {
  let cloud, environment, user, project, taskId
  let settingUp = false
  let quoteIssue, quoteSchedule, quoteAt
  const source = join(workspacePath, FILE)
  const call = (body, id, tool, args, server = 'wework_stand_in') =>
    mcpToolRequestEvents(body, {
      toolName: tool,
      directToolName: `mcp__${server}__${tool}`,
      argumentsValue: args,
      searchCallId: `${id}-search`,
      toolCallId: id,
    }).events
  const has = requestContainsToolOutput
  const role = profile => ({
    ...standInRoleFixture(profile.executionDeviceId, ROLE),
    name: ROLE_NAME,
    enabled: true,
    prompt: `${MARKER}：在我确认的本地仓库 ${workspacePath} 修复开发事项并测试。`,
    collaboration: {
      enabled: true,
      allProjects: false,
      projects: [{ id: String(project.id), store: 'cloud' }],
      excludedProjects: [],
      tags: [MARKER],
      policy: { automatic: true, askBeforeAct: false, immediate: true },
    },
  })
  const model = createIssueDelegationModel({
    marker: MARKER,
    acknowledgment: ACK,
    result: RESULT,
    privateEvidence: PRIVATE,
    simple: SIMPLE,
    answer: ANSWER,
    runWorker(body) {
      const id = 'welcome-assigned-development-patch-and-test'
      if (has(body, id)) {
        assert.ok(readMcpToolOutput(body, id).includes(TESTED), 'The repository test must pass')
        return undefined
      }
      const patch =
        'const fs=require("node:fs"); const assert=require("node:assert/strict"); const file=' +
        JSON.stringify(source) +
        '; assert.equal(fs.readFileSync(file,"utf8"),' +
        JSON.stringify(BAD_SOURCE) +
        '); fs.writeFileSync(file,' +
        JSON.stringify(FIXED_SOURCE) +
        '); assert.equal(require(file)(9),18); console.log(' +
        JSON.stringify(TESTED) +
        ')'
      const script = Buffer.from(patch).toString('base64')
      return selectedToolCall(
        id,
        selectShellToolCommand(
          body,
          `node -e "eval(Buffer.from('${script}', 'base64').toString())"`,
          workspacePath
        )
      )
    },
  })
  async function request(path, body) {
    const response = await fetch(`${cloud.backendUrl}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(uiTimeoutMs),
    })
    const text = await response.text()
    assert.ok(response.ok, `${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }
  const until = (load, ready, label) => storyUntil(load, ready, modelResponseTimeoutMs, label)
  return {
    requiresCloudEnvironment: true,
    async prepareCloud(value) {
      cloud = value
      await request('/admin/setup-complete', {})
      user = await request('/users/me')
      const workspace = await request('/v1/workspaces', { name: MARKER })
      project = await request('/v1/cloud-projects', {
        workspace_id: workspace.id,
        name: MARKER,
        task_provider: 'local',
      })
    },
    setCloudEnvironment(value) {
      environment = value
    },
    async handleHttp(req, response, url) {
      if (
        !settingUp ||
        req.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return model.handleHttp(req, response, url)
      const body = await readRequestBody(req)
      if (isReplyPredictionRequest(body)) return false
      const text = modelMessageText(body.input?.filter(item => item.role === 'user').at(-1))
      let events
      if (text === EXAMPLES.project.prompt) events = [assistantMessage(QUOTE_QUESTION)]
      else if (text.startsWith(QUOTE_SCOPE)) {
        if (!has(body, 'welcome-quote-arrange')) {
          events = call(body, 'welcome-quote-arrange', 'schedule_task', {
            requestId: 'welcome-supplier-quote',
            title: '供应商报价跟进',
            message: `${QUOTE_WORK}，项目 ${project.id}，事项 ${quoteIssue.id}。发现新版时比较总价和交期并给出来源。`,
            at: quoteAt,
            timezone: 'Asia/Shanghai',
          })
        } else {
          quoteSchedule = JSON.parse(readMcpToolOutput(body, 'welcome-quote-arrange')).automation
          assert.ok(quoteSchedule?.id)
          events = [assistantMessage('已安排对指定采购事项的报价跟进。')]
        }
      } else if (quoteSchedule && text.includes(QUOTE_WORK)) {
        const id = 'welcome-quote-read-issue'
        if (!has(body, id))
          events = call(
            body,
            id,
            'get_board_item',
            {
              space_id: String(project.id),
              item_id: quoteIssue.id,
            },
            'wework_space'
          )
        else {
          const item = JSON.parse(readMcpToolOutput(body, id))
          assert.ok(
            item.description.includes(QUOTE_FACTS),
            'The comparison must use actual Issue data'
          )
          events = [
            assistantMessage(`${QUOTE_RESULT} 来源：《${item.title}》（${quoteIssue.id}）。`),
          ]
        }
      } else if (quoteSchedule && text.startsWith('Wework delegated task result:')) {
        events = delegatedTaskResultEvents(body)
      } else if (text === DEVELOPMENT_PROMPT) events = [assistantMessage(SETUP_QUESTION)]
      else if (text.startsWith('确认开发助理只接收')) {
        if (!has(body, 'welcome-development-projects'))
          events = call(body, 'welcome-development-projects', 'list_projects', {})
        else if (!has(body, 'welcome-development-profile'))
          events = call(body, 'welcome-development-profile', 'get_profile', {})
        else if (!has(body, 'welcome-development-proposal')) {
          const projects = JSON.parse(readMcpToolOutput(body, 'welcome-development-projects'))
          assert.ok(projects.items.some(item => String(item.id) === String(project.id)))
          const profile = JSON.parse(readMcpToolOutput(body, 'welcome-development-profile'))
          events = call(body, 'welcome-development-proposal', 'propose_profile', {
            summary: '创建 AI 开发助理，自动执行指定项目中分配给我的开发事项。',
            settings: { ...profile, roles: [...profile.roles, role(profile)] },
          })
        } else events = [assistantMessage('请确认开发范围和执行设备。')]
      }
      if (!events) return model.handleHttp(req, response, url)
      const id = `welcome-development-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      await environment.waitForConnectedAppDevice()
      const rpc = (method, values) => requestExecutor(control, method, values, uiTimeoutMs)
      await writeFile(source, BAD_SOURCE)
      const openHome = async () => {
        await control.command('clickWhenEnabled', '[data-testid="workspace-tab-select-fixed-task"]')
        await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
        const home = '[data-testid="stand-in-welcome"]'
        const welcomeLink = '[data-testid="stand-in-welcome-open"]'
        await control.command('waitFor', `${home}, ${welcomeLink}`)
        if ((await control.command('getElementCount', home, { visible: true })) === '0')
          await control.command('clickWhenEnabled', welcomeLink)
        await control.command('waitFor', home)
      }
      await openHome()
      await control.command(
        'clickWhenEnabled',
        '[data-testid="stand-in-welcome-example-development"]'
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-welcome-start"]')
      const chat = '[data-testid="stand-in-conversation"]'
      const input = `${chat} [data-testid="chat-message-input"]`
      const send = `${chat} [data-testid="send-message-button"]`
      assert.equal(await control.command('getText', input), DEVELOPMENT_PROMPT.replaceAll('\n', ''))
      settingUp = true
      await control.command('clickWhenEnabled', send)
      await control.command('waitFor', `${chat} [data-testid="message-assistant"]`, {
        text: SETUP_QUESTION,
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('fill', input, {
        value: `确认开发助理只接收项目「${MARKER}」中带相同标签的指派事项。仓库 ${workspacePath}，当前设备。`,
      })
      await control.command('clickWhenEnabled', send)
      await control.command('waitFor', '[data-testid="stand-in-proposal"]', {
        text: ROLE_NAME,
        timeoutMs: modelResponseTimeoutMs,
      })
      assert.ok(
        !(await rpc('runtime.stand_in.personal.get', { userId: user.id })).roles.some(
          role => role.id === ROLE
        )
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-proposal-accept"]')
      await until(
        () => rpc('runtime.stand_in.personal.get', { userId: user.id }),
        data => data.roles.some(role => role.id === ROLE),
        'The development role is saved only after confirmation'
      )
      settingUp = false
      const issue = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
        title: `${MARKER}：修复 assigned-issue-fix.cjs，让输入 9 输出 18`,
        tags: [MARKER],
        assignee_user_id: user.id,
      })
      const comments = () =>
        request(`/v1/cloud-projects/${project.id}/loop-items/${issue.id}/activity-comments`)
      const rows = await until(
        comments,
        rows => rows.some(row => row.body === RESULT),
        'Ordinary assignment must return the verified worker result'
      )
      assert.equal(await readFile(source, 'utf8'), FIXED_SOURCE)
      assert.ok(model.state.spawned && model.state.childRan && model.state.completed)
      assert.deepEqual(
        rows.map(row => row.body),
        [ACK, RESULT],
        'Only acceptance and verified result become comments; worker evidence stays private'
      )
      const bindings = await request(`/v1/loop-items/${issue.id}/tasks`)
      assert.equal(bindings.length, 1, 'Native delegation must retain one Issue conversation')
      taskId = bindings[0].task_id
      const settled = () =>
        until(
          () => rpc('runtime.tasks.get', { taskId }),
          value => value.task?.status === 'done' && value.task.running !== true,
          'Issue conversation must finish'
        )
      const first = await settled()
      const activity = `[data-workspace-tab-content][aria-hidden="false"] [data-testid="cloud-task-activity-${issue.id}"]`
      await control.command('openWeworkScheme', 'body', {
        value: `wework://boards/${project.id}/issues/${issue.id}`,
      })
      await control.command('waitFor', activity, { text: RESULT })
      await control.command(
        'click',
        `${activity} [data-testid="cloud-task-activity-reply-toggle-${rows.find(row => row.body === RESULT).id}"]`
      )
      await control.command('waitFor', '[data-testid="issue-reply-composer"]')
      const form = `[data-workspace-tab-content][aria-hidden="false"] ${issueCommentFormSelector(issue.id)}`
      await control.command('fill', `${form} [data-testid="cloud-task-activity-composer"]`, {
        value: SIMPLE,
      })
      await control.command('clickWhenEnabled', `${form} [data-testid="send-message-button"]`)
      const final = await until(
        comments,
        rows => rows.some(row => row.body === ANSWER),
        'Simple follow-up must be answered directly in the same conversation'
      )
      assert.equal((await settled()).task.threadId, first.task.threadId)
      assert.deepEqual(
        final.map(row => row.body),
        [ACK, RESULT, SIMPLE, ANSWER]
      )
      await control.command('waitFor', activity, { text: ANSWER })
      quoteIssue = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
        title: '采购评审的供应商报价',
        description: QUOTE_FACTS,
      })
      // The business trigger remains future-dated. Run now verifies the new quote branch.
      const timezoneOffset = 8 * 60 * 60 * 1000
      const friday = new Date(Date.now() + timezoneOffset)
      friday.setUTCDate(friday.getUTCDate() + ((5 - friday.getUTCDay() + 7) % 7))
      friday.setUTCHours(17, 0, 0, 0)
      if (friday.getTime() - timezoneOffset <= Date.now())
        friday.setUTCDate(friday.getUTCDate() + 7)
      quoteAt = new Date(friday.getTime() - timezoneOffset).toISOString()
      await openHome()
      await control.command('clickWhenEnabled', '[data-testid="stand-in-welcome-more"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-template-library-project"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-welcome-start"]')
      settingUp = true
      await control.command('clickWhenEnabled', send)
      await control.command('waitFor', `${chat} [data-testid="message-assistant"]`, {
        text: QUOTE_QUESTION,
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('fill', input, {
        value: `${QUOTE_SCOPE}项目 ${project.id} 的事项 ${quoteIssue.id}，Asia/Shanghai，提醒时间 ${quoteAt}。`,
      })
      await control.command('clickWhenEnabled', send)
      await control.command('waitFor', `${chat} [data-testid="message-assistant"]`, {
        text: '已安排对指定采购事项的报价跟进',
        timeoutMs: modelResponseTimeoutMs,
      })
      const triggered = await rpc('runtime.automations.run_now', { automationId: quoteSchedule.id })
      assert.ok(triggered.run?.id)
      await until(
        async () =>
          (
            await rpc('runtime.automation_runs.list', { automationId: quoteSchedule.id })
          ).items.find(row => row.id === triggered.run.id),
        run => run?.status === 'succeeded',
        'The requested supplier follow-up must complete immediately from its configured Issue'
      )
      await control.command('waitFor', `${chat} [data-testid="message-assistant"]`, {
        text: QUOTE_RESULT,
        timeoutMs: modelResponseTimeoutMs,
      })
      await rpc('runtime.automations.delete', { automationId: quoteSchedule.id })
      settingUp = false
      await control.command('openWeworkScheme', 'body', {
        value: `wework://boards/${project.id}/issues/${issue.id}`,
      })
      const current = await rpc('runtime.stand_in.personal.get', { userId: user.id })
      await rpc('runtime.stand_in.personal.save', {
        userId: user.id,
        settings: { ...current, roles: current.roles.filter(role => role.id !== ROLE) },
      })
    },
    diagnostics() {
      return { projectId: project?.id, taskId, ...model.state }
    },
  }
}
