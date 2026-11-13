import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import { DEFAULT_MODEL_ID, MODEL_PROVIDER_ID } from '../modules/shared.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'
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

const HOME = '[data-workspace-tab-content][aria-hidden="false"] [data-testid="personal-home"]'
const CHAT = `${HOME} [data-testid="personal-home-general-chat"]`
const INPUT = `${CHAT} [data-testid="chat-message-input"]`
const MARKER = 'HOME_ASSISTANT_STORY'
const QUERY_RESULT = `${MARKER}_READ_VERIFIED`
const WRITE_RESULT = `${MARKER}_WRITE_VERIFIED`
const CONTINUE_RESULT = `${MARKER}_CONTEXT_RESTORED`
const ORIGINAL = 'Draft ready for product review.'
const UPDATED = `${ORIGINAL}\n\nAcceptance: the release owner reviews the approved copy.`

/** Keep native collaboration and persistence real; simulate only model responses. */
export function createDesktopScenario(options) {
  let project
  let issue
  let phase = 0
  let enabled = false
  const calls = new Set()
  const tool = (body, name, id, args) =>
    mcpToolRequestEvents(body, {
      toolName: name,
      toolCallId: id,
      searchCallId: `${id}-search`,
      argumentsValue: args,
    }).events
  const output = (body, id, text) => {
    const result = readMcpToolOutput(body, id)
    assert.ok(result.includes(text), `Real ${id} result must contain ${text}: ${result}`)
    calls.add(id)
  }
  const respond = (response, events) => {
    const id = `home-assistant-${Date.now()}`
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
    return true
  }
  return {
    appEnvironment: {
      WEWORK_E2E_CLOUD_BACKEND_URL: '',
      VITE_WEWORK_E2E_CLOUD_BACKEND_URL: '',
      WEWORK_E2E_CLOUD_TOKEN: '',
      VITE_WEWORK_E2E_CLOUD_TOKEN: '',
    },
    async handleHttp(request, response, url) {
      if (
        !enabled ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const input = JSON.stringify(body.input ?? [])
      if (!input.includes(MARKER)) return false
      if (phase === 0) {
        if (!requestContainsToolOutput(body, 'home-spaces'))
          return respond(response, tool(body, 'list_spaces', 'home-spaces', {}))
        output(body, 'home-spaces', project.name)
        if (!requestContainsToolOutput(body, 'home-read'))
          return respond(
            response,
            tool(body, 'get_board_item', 'home-read', { space_id: project.id, item_id: issue.id })
          )
        output(body, 'home-read', ORIGINAL)
        return respond(response, [assistantMessage(QUERY_RESULT)])
      }
      if (phase === 1) {
        if (!requestContainsToolOutput(body, 'home-write'))
          return respond(
            response,
            tool(body, 'update_board_item', 'home-write', {
              space_id: project.id,
              item_id: issue.id,
              item: { version: issue.version, description: UPDATED },
            })
          )
        output(body, 'home-write', 'Acceptance:')
        return respond(response, [assistantMessage(WRITE_RESULT)])
      }
      assert.ok(input.includes(QUERY_RESULT), 'Reload must restore earlier assistant context')
      assert.ok(input.includes(WRITE_RESULT), 'Follow-up must remain in the same home conversation')
      return respond(response, [assistantMessage(CONTINUE_RESULT)])
    },
    async verify(control) {
      await control.command('clickWhenEnabled', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('waitFor', HOME, { timeoutMs: options.workbenchReadyTimeoutMs })
      const rpc = (method, params) => requestExecutor(control, method, params, options.uiTimeoutMs)
      // Each checkpoint owns its minimal local project and Issue fixtures.
      project = await rpc('projects.create', { name: `Home assistant ${process.pid}` })
      issue = await rpc('todos.create', {
        project_id: project.id,
        todo: { title: 'Review release notes', description: ORIGINAL },
      })
      await reloadMainWindow(control, 'The homepage must reconnect after creating its fixtures')
      await control.command('waitFor', CHAT, { timeoutMs: options.workbenchReadyTimeoutMs })
      const catalog = await rpc('runtime.runner.catalog', {})
      const model = catalog.models.find(
        row =>
          row.runtime === 'codex' &&
          row.provider === MODEL_PROVIDER_ID &&
          row.model_id === DEFAULT_MODEL_ID
      )
      assert.ok(model, 'The shared native Codex Responses model must be available')
      const settings = await rpc('runtime.stand_in.personal.get', { userId: 0 })
      const send = async (message, result) => {
        await control.command('fill', INPUT, { value: message })
        await control.command('clickWhenEnabled', `${CHAT} [data-testid="send-message-button"]`)
        await control.command('waitFor', CHAT, {
          text: result,
          timeoutMs: options.modelResponseTimeoutMs,
        })
        await until(
          () => rpc('runtime.tasks.get', { taskId: 'stand-in-chat-0-primary-collaboration' }),
          result => result.task?.running === false,
          'The homepage model turn must settle before advancing the model fixture',
          options.modelResponseTimeoutMs
        )
        assert.equal(
          Number(await control.command('getElementCount', HOME)),
          1,
          'The user must stay on the collaboration home'
        )
      }
      enabled = true
      await send(`${MARKER}: read the current project progress without changing it.`, QUERY_RESULT)
      const before = (
        await rpc('runtime.tasks.get', { taskId: 'stand-in-chat-0-primary-collaboration' })
      ).task
      assert.ok(before.threadId)
      assert.equal(before.runtimeHandle.origin.conversationScope, 'collaboration')
      const unchanged = await rpc('todos.get', { project_id: project.id, task_id: issue.id })
      assert.equal(unchanged.description, ORIGINAL)
      phase = 1
      issue = unchanged
      await send(
        `${MARKER}: append the agreed acceptance criterion to the Issue description.`,
        WRITE_RESULT
      )
      const updated = await rpc('todos.get', { project_id: project.id, task_id: issue.id })
      assert.equal(updated.description, UPDATED)
      assert.equal(updated.title, issue.title)
      assert.equal(updated.status, issue.status)
      assert.equal(updated.priority, issue.priority)
      await control.command(
        'clickWhenEnabled',
        `${HOME} [data-testid="personal-home-scope-participating"]`
      )
      await control.command('waitFor', `${HOME} [data-testid="personal-home-issue-${issue.id}"]`)
      await control.command('fill', INPUT, { value: 'Keep my homepage draft' })
      await control.command(
        'clickWhenEnabled',
        `${HOME} [data-testid="personal-home-assistant-view-toggle"]`
      )
      await control.command('waitFor', `${HOME} [data-testid="personal-home-assistant-work-items"]`)
      await control.command(
        'clickWhenEnabled',
        `${HOME} [data-testid="personal-home-assistant-view-toggle"]`
      )
      assert.equal(await control.command('getValue', INPUT), 'Keep my homepage draft')
      await control.command(
        'clickWhenEnabled',
        `${HOME} [data-testid="personal-home-issue-${issue.id}"]`
      )
      await control.command('waitFor', `${HOME} [data-testid="cloud-todo-detail-description"]`, {
        text: 'Acceptance:',
      })
      await control.command(
        'clickWhenEnabled',
        `${HOME} [data-testid="personal-home-tab-stand-in"]`
      )
      assert.equal(await control.command('getValue', INPUT), 'Keep my homepage draft')
      await reloadMainWindow(control, 'The homepage must reconnect before restoring its chat')
      await control.command('waitFor', CHAT, {
        text: WRITE_RESULT,
        timeoutMs: options.workbenchReadyTimeoutMs,
      })
      phase = 2
      await send(`${MARKER}: continue our previous discussion from this homepage.`, CONTINUE_RESULT)
      const after = (await rpc('runtime.tasks.get', { taskId: before.taskId })).task
      assert.equal(after.threadId, before.threadId, 'Homepage reentry must reuse its native thread')
      assert.equal(after.runtime, 'codex')
      assert.deepEqual(
        await rpc('runtime.stand_in.personal.get', { userId: 0 }),
        settings,
        'Homepage chat must reuse the primary identity without copying or changing its configuration'
      )
      assert.deepEqual([...calls].sort(), ['home-read', 'home-spaces', 'home-write'])
    },
    diagnostics() {
      return { homeAssistantCalls: [...calls], homeAssistantPhase: phase }
    },
  }
}
