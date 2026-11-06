import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ACTIVE_SEND_BUTTON_SELECTOR } from '../modules/shared.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  toolOutputText,
} from '../modules/response-protocol.mjs'

const prompt = 'WEWORK_E2E_ORDINARY_MCP'
const completion = 'ORDINARY_MCP_COMPLETE'
const callId = 'ordinary-mcp-read'
const composer =
  '[data-active-workbench-pane="true"] [data-testid="chat-message-input"][contenteditable="true"]'

export function createOrdinaryMcpRegression({ uiTimeoutMs, modelResponseTimeoutMs }) {
  let configPath
  let active = false
  return {
    prepareApp({ codexHome }) {
      configPath = join(codexHome, 'config.toml')
    },
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      assert.ok(JSON.stringify(body).includes(prompt))
      const completed = requestContainsToolOutput(body, callId)
      if (completed) {
        const output = toolOutputText(body, callId) ?? ''
        const result = output.includes('Output:\n') ? output.split('Output:\n').at(-1) : output
        assert.deepEqual(JSON.parse(result), { count: 0 })
      }
      const events = completed
        ? [assistantMessage(completion), responseCompleted('ordinary-mcp', [])]
        : [
            ...mcpToolRequestEvents(body, {
              toolName: 'model_only',
              argumentsValue: {},
              directToolName: 'mcp__counter__model_only',
              searchCallId: `${callId}-search`,
              toolCallId: callId,
            }).events,
            responseCompleted('ordinary-mcp'),
          ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(createSse([responseCreated('ordinary-mcp'), ...events]))
      return true
    },
    async verify(control) {
      active = true
      await control.command('fill', composer, { value: prompt })
      await control.command('waitFor', `${ACTIVE_SEND_BUTTON_SELECTOR}:not(:disabled)`)
      await control.command('press', composer, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: completion,
        timeoutMs: modelResponseTimeoutMs,
      })
      const address = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        .workbench.currentRuntimeTask
      assert.ok(address.taskId)
      const discover = () =>
        requestExecutor(control, 'runtime.mcp_apps.request', { address, callId }, uiTimeoutMs)
      assert.equal(await discover(), null)
      assert.equal(Number(await control.command('getElementCount', '[data-testid="mcp-app"]')), 0)

      // Remove the real server from this isolated session's configuration, then
      // reopen its persisted ordinary invocation with the real app-server restarted.
      const config = await readFile(configPath, 'utf8')
      assert.ok(config.includes('[mcp_servers.counter]'))
      try {
        await writeFile(
          configPath,
          config.replace('[mcp_servers.counter]', '[mcp_servers.counter]\nenabled = false')
        )
        await requestExecutor(control, 'runtime.codex.app_server.restart', {}, uiTimeoutMs)
        assert.equal(await discover(), null)
        await assert.rejects(
          requestExecutor(
            control,
            'runtime.mcp_apps.request',
            {
              address,
              callId,
              method: 'tools/call',
              params: { name: 'model_only', arguments: {} },
            },
            uiTimeoutMs
          )
        )
        await control.command('click', '[data-testid="new-chat-button"]')
        await control.command('waitFor', composer)
        await control.command('navigate', 'body', {
          value: `/runtime-tasks?${new URLSearchParams({ deviceId: address.deviceId, taskId: address.taskId })}`,
        })
        await control.command('waitFor', '[data-testid="message-assistant"]', { text: completion })
        assert.equal(await discover(), null)
        assert.equal(
          Number(await control.command('getElementCount', '[data-testid="mcp-app"]')),
          0,
          'An ordinary historical tool call must not render an MCP App error card'
        )
        const snapshot = JSON.parse(await control.command('snapshot', 'body'))
        assert.ok(!snapshot.text.includes('Source MCP server is no longer available'))
      } finally {
        await writeFile(configPath, config)
      }
    },
  }
}
