import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'
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
} from '../modules/response-protocol.mjs'

const prompt = 'WEWORK_E2E_MCP_APP'
const completion = 'MCP_APP_COMPLETE'
const callId = 'mcp-app-open'
const composer =
  '[data-active-workbench-pane="true"] [data-testid="chat-message-input"][contenteditable="true"]'

export function createDesktopScenario({ workspacePath, uiTimeoutMs, modelResponseTimeoutMs }) {
  let calls = 0
  let activeCase = { callId, tool: 'show_app', prompt, completion }
  return {
    codexConfigToml: `\n[mcp_servers.counter]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fileURLToPath(new URL('../../utils/mcp-app-server.mjs', import.meta.url)))}]\n`,
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      assert.ok(JSON.stringify(body).includes(activeCase.prompt))
      if (activeCase.tool !== 'show_app') {
        assert.ok(
          JSON.stringify(body).includes('counter-selection'),
          'App context must reach the next model turn'
        )
      }
      calls++
      let events
      if (requestContainsToolOutput(body, activeCase.callId)) {
        events = [assistantMessage(activeCase.completion), responseCompleted('mcp-app', [])]
      } else {
        events = [
          ...mcpToolRequestEvents(body, {
            toolName: activeCase.tool,
            argumentsValue: {},
            directToolName: `mcp__counter__${activeCase.tool}`,
            searchCallId: `${activeCase.callId}-search`,
            toolCallId: activeCase.callId,
          }).events,
          responseCompleted('mcp-app'),
        ]
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(createSse([responseCreated('mcp-app'), ...events]))
      return true
    },
    async verify(control) {
      await createSingleRootLocalProject(control, workspacePath, 'mcp-apps')
      await selectE2EModel(control)
      await control.command('fill', composer, { value: prompt })
      await control.command('press', composer, { key: 'Enter' })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: completion,
        timeoutMs: modelResponseTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="mcp-app-frame"][data-ready="true"]', {
        timeoutMs: modelResponseTimeoutMs,
      })
      const address = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        .workbench.currentRuntimeTask
      assert.ok(address.taskId)
      const origin = await control.command('getLocationOrigin', 'body')
      let frameUrl = await control.command('getAttribute', '[data-testid="mcp-app-frame"]', {
        value: 'src',
      })
      assert.ok(frameUrl.startsWith('http://127.0.0.1:'))
      const frameAction = async (action, selector, value) => {
        const response = await fetch(`${origin}/wework/electron-host/v1/invoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            capability: 'e2e.mcpAppFrame',
            params: { url: frameUrl, action, selector, value },
          }),
          signal: AbortSignal.timeout(uiTimeoutMs),
        })
        const result = await response.json()
        assert.equal(result.ok, true, JSON.stringify(result.error))
        return result.result
      }
      const waitText = async text => {
        const deadline = Date.now() + uiTimeoutMs
        let actual
        do {
          actual = await frameAction('text', '#status')
          if (actual === text) return
          await new Promise(resolve => setTimeout(resolve, 100))
        } while (Date.now() < deadline)
        assert.equal(actual, text)
      }
      await waitText('Result 0 ui-only-marker')
      assert.equal(await frameAction('attribute', 'body', 'data-csp'), 'blocked')
      await frameAction('fill', '#draft', 'preserved draft')
      await frameAction('click', '#refresh')
      await waitText('Counter 1')
      await frameAction('click', '#context')
      await waitText('Context saved')
      await frameAction('click', '#expand')
      await control.command(
        'waitFor',
        '[data-testid="mcp-app-overlays"] [data-testid="mcp-app"][data-display-mode="fullscreen"]'
      )
      const [viewport] = JSON.parse(await control.command('getElementMetrics', 'body'))
      const [fullscreen] = JSON.parse(
        await control.command(
          'getElementMetrics',
          '[data-testid="mcp-app"][data-display-mode="fullscreen"]'
        )
      )
      assert.equal(fullscreen.left, 0)
      assert.equal(fullscreen.top, 0)
      assert.equal(fullscreen.width, viewport.clientWidth)
      assert.equal(fullscreen.height, viewport.clientHeight)
      assert.equal(
        await control.command('getAttribute', '[data-testid="mcp-app-frame"]', { value: 'src' }),
        frameUrl
      )
      await control.command('click', '[data-testid="mcp-app-expand"]')
      await control.command('waitFor', '[data-testid="mcp-app"][data-display-mode="inline"]')
      assert.equal(await frameAction('value', '#draft'), 'preserved draft')
      await frameAction('click', '#pip')
      await control.command(
        'waitFor',
        '[data-testid="mcp-app-overlays"] [data-testid="mcp-app"][data-display-mode="pip"]'
      )
      const [pip] = JSON.parse(
        await control.command(
          'getElementMetrics',
          '[data-testid="mcp-app"][data-display-mode="pip"]'
        )
      )
      assert.equal(pip.right, viewport.clientWidth - 16)
      assert.equal(pip.bottom, viewport.clientHeight - 16)
      assert.equal(await frameAction('value', '#draft'), 'preserved draft')
      await control.command('click', '[data-testid="mcp-app-expand"]')
      await control.command('click', '[data-testid="mcp-app-expand"]')
      await control.command('waitFor', '[data-testid="mcp-app"][data-display-mode="inline"]')
      const list = await requestExecutor(
        control,
        'runtime.mcp_apps.request',
        { address, callId, method: 'tools/list' },
        uiTimeoutMs
      )
      assert.ok(list.tools.some(tool => tool.name === 'read_count'))
      assert.ok(!list.tools.some(tool => tool.name === 'model_only'))
      for (const data of [
        { callId: 'foreign', method: 'initialize' },
        { callId, method: 'tools/call', params: { name: 'model_only', arguments: {} } },
        { callId, method: 'tools/call', params: { name: 'change_count', arguments: {} } },
      ]) {
        await assert.rejects(
          requestExecutor(control, 'runtime.mcp_apps.request', { address, ...data }, uiTimeoutMs)
        )
      }
      await control.command('click', '[data-testid="mcp-app-close"]')
      await control.command('waitFor', '[data-testid="mcp-app-frame"]', {
        visible: false,
      })
      await assert.rejects(fetch(frameUrl))
      for (const [tool, expected] of [
        ['show_legacy', 'Legacy 1'],
        ['show_dynamic', 'Result 2 ui-only-marker'],
        ['show_recovery', 'Result 3 ui-only-marker'],
      ]) {
        activeCase = {
          callId: 'mcp-app-' + tool,
          tool,
          prompt: prompt + '_' + tool,
          completion: completion + '_' + tool,
        }
        await control.command('fill', composer, { value: activeCase.prompt })
        await control.command('press', composer, { key: 'Enter' })
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: activeCase.completion,
          timeoutMs: modelResponseTimeoutMs,
        })
        const scope = '[data-mcp-call-id="' + activeCase.callId + '"]'
        if (tool === 'show_recovery') {
          await control.command('waitFor', scope + ' [data-testid="mcp-app-retry"]')
          await control.command('click', scope + ' [data-testid="mcp-app-retry"]')
        }
        await control.command(
          'waitFor',
          scope + ' [data-testid="mcp-app-frame"][data-ready="true"]'
        )
        frameUrl = await control.command('getAttribute', scope + ' [data-testid="mcp-app-frame"]', {
          value: 'src',
        })
        await waitText(expected)
        await frameAction('click', '#refresh')
        await waitText('Counter ' + (tool === 'show_legacy' ? 2 : tool === 'show_dynamic' ? 3 : 4))
        await control.command('click', scope + ' [data-testid="mcp-app-close"]')
        await control.command('waitFor', scope + ' [data-testid="mcp-app-frame"]', {
          visible: false,
        })
        await assert.rejects(fetch(frameUrl))
      }
      const original = '[data-mcp-call-id="' + callId + '"]'
      await control.command('click', original + ' [data-testid="mcp-app-expand"]')
      await control.command(
        'waitFor',
        original + ' [data-testid="mcp-app-frame"][data-ready="true"]'
      )
      frameUrl = await control.command(
        'getAttribute',
        original + ' [data-testid="mcp-app-frame"]',
        { value: 'src' }
      )
      await waitText('Result 0 ui-only-marker')
      await control.command('click', original + ' [data-testid="mcp-app-close"]')
      await control.command('waitFor', original + ' [data-testid="mcp-app-frame"]', {
        visible: false,
      })
      await assert.rejects(fetch(frameUrl))
      await control.command('click', original + ' [data-testid="mcp-app-expand"]')
      await control.command(
        'waitFor',
        original + ' [data-testid="mcp-app-frame"][data-ready="true"]'
      )
      frameUrl = await control.command(
        'getAttribute',
        original + ' [data-testid="mcp-app-frame"]',
        { value: 'src' }
      )
      await waitText('Result 0 ui-only-marker')
      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', composer)
      await control.command('waitFor', '[data-testid="mcp-app-frame"]', { visible: false })
      const releaseDeadline = Date.now() + uiTimeoutMs
      let released = false
      do {
        try {
          await fetch(frameUrl)
        } catch {
          released = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      } while (Date.now() < releaseDeadline)
      assert.ok(released, 'Leaving the task must release its app document')
      assert.ok(calls >= 8)
    },
  }
}
