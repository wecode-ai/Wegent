import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import { modelRequestTexts } from '../modules/model-tool-output.mjs'
import { createLocalCollaborationProject } from '../modules/workspace-flows.mjs'
import { selectE2EModel } from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const PROJECT = `事项查询-${process.pid}`
const ISSUE_TITLE = 'SIDEBAR_QUERY_REAL_ISSUE'
const MISSING = 'SIDEBAR_QUERY_NO_MATCH'
const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const CHAT = `${CONTENT} [data-testid="project-space-chat-panel"]`
const INPUT = `${CHAT} [data-testid="chat-message-input"]`
const SEND = `${CHAT} [data-testid="send-message-button"]`
const COMPLETED_TURN = `${CHAT} [data-testid="processing-duration-label"]`

async function waitForCompletedProjectChatTurn(control, completedTurnsBefore, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const [completedTurns, activeTurns, inputValue] = await Promise.all([
      control.command('getElementCount', COMPLETED_TURN),
      control.command('getElementCount', `${CHAT} [data-testid="pause-response-button"]`),
      control.command('getValue', INPUT),
    ])
    if (Number(completedTurns) > completedTurnsBefore && Number(activeTurns) === 0 && !inputValue) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('The project chat turn did not finish before the next query')
}

// Only model decisions are synthetic: project storage, MCP and conversation reads are real.
// This verifies context delivery and tool integration, not a live model's language inference.
export function createDesktopScenario({ uiTimeoutMs, modelResponseTimeoutMs }) {
  let project
  let issue
  let activeCase
  let completed = false
  let contextRead = false
  const observed = []

  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (!activeCase || !JSON.stringify(body.input ?? []).includes(activeCase.prompt)) return false
      const context = modelRequestTexts(body)
      assert.ok(context.includes(PROJECT), 'Every query retains the selected project context')
      assert.ok(context.includes('"查一下事项"'), 'Issue query vocabulary reaches the model')
      assert.ok(
        context.includes('personal tasks or conversations'),
        'Personal task routing reaches every turn'
      )
      const id = `sidebar-query-${activeCase.name}`
      const contextCallId = `${id}-context`
      if (!contextRead && requestContainsToolOutput(body, contextCallId)) {
        const binding = JSON.parse(readMcpToolOutput(body, contextCallId))
        assert.equal(binding.space_id, project.id)
        assert.equal(binding.item_id, null)
        contextRead = true
      }
      const callId = `${id}-tool`
      if (!completed && requestContainsToolOutput(body, callId)) {
        const output = readMcpToolOutput(body, callId)
        activeCase.verify(output)
        observed.push(activeCase.name)
        completed = true
      }
      const events = !contextRead
        ? mcpToolRequestEvents(body, {
            toolName: 'get_current_context',
            directToolName: 'mcp__wework_space__get_current_context',
            argumentsValue: {},
            searchCallId: `${contextCallId}-search`,
            toolCallId: contextCallId,
          }).events
        : completed
          ? [assistantMessage(activeCase.reply)]
          : mcpToolRequestEvents(body, {
              toolName: activeCase.tool,
              directToolName: `mcp__${activeCase.server}__${activeCase.tool}`,
              argumentsValue: activeCase.args,
              searchCallId: `${id}-search`,
              toolCallId: callId,
            }).events
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, CONTENT, PROJECT)
      project = (await rpc('projects.list', {})).find(row => row.name === PROJECT)
      assert.ok(project)
      // Local space references use the IPC identity without requiring cloud registration.
      const { deviceId } = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
      assert.ok(deviceId, 'The local Executor must expose its IPC identity')
      const space = { project_store: 'local', space_id: project.id, device_id: deviceId }
      issue = await rpc('todos.create', {
        project_id: project.id,
        todo: { title: ISSUE_TITLE },
      })
      await control.command(
        'clickWhenEnabled',
        `${CONTENT} [data-testid="project-space-chat-open"]`
      )
      await control.command('waitFor', CHAT)
      await selectE2EModel(control, undefined, undefined, CHAT)
      const cases = [
        {
          name: 'issues',
          prompt: '查一下事项',
          server: 'wework_space',
          tool: 'list_board_items',
          args: { space_id: project.id },
          verify: output => {
            const items = JSON.parse(output)
            assert.ok(Array.isArray(items), output)
            assert.ok(items.some(item => item.id === issue.id && item.title === ISSUE_TITLE))
            assert.ok(
              items.every(item => item.cloud_project_id === project.id),
              output
            )
          },
          reply: `项目：${PROJECT}，Issue：${issue.id} ${ISSUE_TITLE}`,
        },
        {
          name: 'empty',
          prompt: `查一下事项 ${MISSING}`,
          server: 'wework_space',
          tool: 'search_board_items',
          args: { scope: { kind: 'projects', spaces: [space] }, query: MISSING },
          verify: output => {
            const page = JSON.parse(output)
            assert.deepEqual(page.items, [])
            assert.equal(page.matched_total, 0)
            assert.equal(page.next_cursor, null)
            assert.equal(page.coverage.complete, true)
            assert.deepEqual(page.coverage.sources, [{ space, state: 'complete', reason: null }])
            assert.equal(typeof page.query_id, 'string')
          },
          reply: `当前项目“${PROJECT}”未找到匹配事项（Issue）：${MISSING}`,
        },
        {
          name: 'personal',
          prompt: '查询我的个人任务（会话）',
          server: 'wework_control',
          tool: 'invoke_capability',
          args: {
            name: 'list_conversations',
            arguments: { scope: 'current_device', limit: 100 },
          },
          verify: output => {
            assert.doesNotMatch(output, /"isError"\s*:\s*true/)
            assert.match(output, /"conversation_id"\s*:/)
          },
          reply: '已查询个人任务（会话）。SIDEBAR_PERSONAL_QUERY_COMPLETE',
        },
      ]
      for (const query of cases) {
        activeCase = query
        completed = false
        contextRead = query.server !== 'wework_space'
        const completedTurnsBefore = Number(
          await control.command('getElementCount', COMPLETED_TURN)
        )
        await control.command('fill', INPUT, {
          value: query.prompt,
        })
        await control.command('waitFor', INPUT, {
          text: query.prompt,
          stableMs: 250,
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', SEND, {
          enabled: true,
          visible: true,
          timeoutMs: modelResponseTimeoutMs,
        })
        await control.command('click', SEND)
        await control.command('waitFor', CHAT, {
          text: query.reply,
          timeoutMs: modelResponseTimeoutMs,
        })
        await waitForCompletedProjectChatTurn(control, completedTurnsBefore, uiTimeoutMs)
        assert.equal(completed, true, `${query.name} must finish its real tool call`)
      }
      assert.deepEqual(observed, ['issues', 'empty', 'personal'])
      await control.command('click', `${CONTENT} [data-testid="project-space-chat-close"]`)
      // The shared checkpoint runner removes the isolated Executor and project fixtures.
      return { projectId: project.id, issueId: issue.id, observed }
    },
  }
}
