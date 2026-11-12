import assert from 'node:assert/strict'
import {
  ACTIVE_SEND_BUTTON_SELECTOR,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'
import { readNativeToolCallId } from '../modules/native-tool-call-id.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { fetchLocalRuntime } from '../modules/runtime-request.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'
import { waitForCompletedRuntimeTaskThread } from '../modules/runtime-task-evidence.mjs'
import { getSingleElementMetrics, SCROLLER_SELECTOR } from '../modules/streaming-text-fixture.mjs'
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

const composer =
  '[data-active-workbench-pane="true"] [data-testid="chat-message-input"][contenteditable="true"]'
const formPrompt = 'WEWORK_GENERATED_SCHEDULE_FORM'
const resultsPrompt = 'WEWORK_GENERATED_CONVERSATION_RESULTS'
const scheduleName = 'Generated HTML real schedule'
const archivePrompt = 'WEWORK_GENERATED_ARCHIVE_TARGET'
const archiveTaskId = 'generated-html-archive-target'

// These are model outputs, not product templates. Only the model is simulated.
const formHtml = `<section id="generated-schedule">
  <form data-testid="generated-form">
    <label>Name <input data-testid="generated-name" required></label>
    <label>Instructions <textarea data-testid="generated-prompt" rows="40" required></textarea></label>
    <button data-testid="generated-save">Create schedule</button>
  </form>
  <output data-testid="generated-status"></output>
  <style>#generated-schedule{padding:16px}#generated-schedule label{display:block;margin-bottom:12px}#generated-schedule input,#generated-schedule textarea{display:block;width:100%;font:inherit;color:var(--foreground);background:var(--background)}#generated-schedule button{min-height:44px}</style>
  <script>
    (() => {
      const root = document.getElementById('generated-schedule')
      const status = () => root.querySelector('[data-testid="generated-status"]')
      async function showResults() {
        const result = await window.wework.callTool('list_automations', {})
        const saved = result.items.find(item => item.id === window.wework.state.createdId)
        if (!saved) throw new Error('Created schedule is missing')
        root.innerHTML = '<output data-testid="generated-status"></output><p data-testid="generated-result"></p>'
        status().textContent = 'Created'
        root.querySelector('[data-testid="generated-result"]').textContent = saved.name + ' ' + saved.id
      }
      root.querySelector('form').onsubmit = async event => {
        event.preventDefault()
        const button = root.querySelector('button')
        button.disabled = true
        try {
          const result = await window.wework.callTool('create_automation', {
            name: root.querySelector('input').value,
            prompt: root.querySelector('textarea').value,
            schedule: {type:'interval',value:1,unit:'days'},
            timezone: window.wework.context.timeZone,
            enabled: false
          })
          await window.wework.setState({view:'results',createdId:result.automation.id})
          await showResults()
        } catch (error) { status().textContent = error.message; button.disabled = false }
      }
      if (window.wework.state?.view === 'results') showResults().catch(error => {status().textContent=error.message})
    })()
  </script>
</section>`

const resultsHtml = `<section id="generated-conversations">
  <button data-testid="generated-query">Find conversations</button>
  <button data-testid="generated-navigation">Open archived tasks</button>
  <output data-testid="generated-query-status"></output>
  <ul data-testid="generated-conversations"></ul>
  <script>
    (() => {
      const root = document.getElementById('generated-conversations')
      const status = root.querySelector('output')
      async function load() {
        try {
          const result = await window.wework.callTool('list_conversations', {scope:'current_device',include_archived:true})
          const list = root.querySelector('ul')
          list.replaceChildren()
          for (const item of result.items) {
            if (item.status !== 'archived' && item.conversation_id !== window.wework.state?.restoredId) continue
            const row = document.createElement('li')
            const title = document.createElement('span')
            title.textContent = item.title
            const button = document.createElement('button')
            function showOpen() {
              button.disabled = false
              button.textContent = 'Open conversation'
              button.dataset.testid = 'generated-open-' + item.taskId
              button.onclick = async () => {
                try {
                  await window.wework.navigate('wework://tasks/' + encodeURIComponent(item.device_id) + '/' + encodeURIComponent(item.taskId))
                } catch(error) {status.textContent=error.message}
              }
            }
            if (item.status === 'archived') {
              button.textContent = 'Restore'
              button.dataset.testid = 'generated-restore-' + item.taskId
              button.onclick = async () => {
                button.disabled = true
                try {
                  const restored = await window.wework.callTool('unarchive_conversation', {conversation_id:item.conversation_id})
                  if (!restored.accepted) throw new Error('Restoration was not accepted')
                  showOpen()
                  await window.wework.setState({restoredId:item.conversation_id})
                  status.textContent = 'Restored'
                } catch(error) {status.textContent=error.message;button.disabled=false}
              }
            } else showOpen()
            row.append(title, button)
            list.append(row)
          }
          status.textContent = 'Loaded ' + result.items.length
        } catch(error) {status.textContent=error.message}
      }
      root.querySelector('[data-testid="generated-query"]').onclick = load
      if (window.wework.state?.restoredId) load()
      root.querySelector('[data-testid="generated-navigation"]').onclick = async () => {
        try {
          const target = window.wework.navigationTargets.find(item => /archiv/i.test(item.id))
          if (!target) throw new Error('Registered archive destination is missing')
          await window.wework.navigate(target.path)
        } catch(error) {status.textContent=error.message}
      }
    })()
  </script>
</section>`

export function createDesktopScenario({ workspacePath, uiTimeoutMs, modelResponseTimeoutMs }) {
  let active = {
    prompt: formPrompt,
    id: 'generated-form',
    html: formHtml,
    tools: ['create_automation', 'list_automations'],
  }
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (JSON.stringify(body).includes(archivePrompt)) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(
          createSse([
            responseCreated(archiveTaskId),
            assistantMessage(archivePrompt),
            responseCompleted(archiveTaskId),
          ])
        )
        return true
      }
      assert.ok(JSON.stringify(body).includes(active.prompt))
      const events = requestContainsToolOutput(body, active.id)
        ? [assistantMessage(active.id + '-ready'), responseCompleted(active.id)]
        : [
            ...mcpToolRequestEvents(body, {
              toolName: 'present_interaction',
              directToolName: 'mcp__wework_control__present_interaction',
              argumentsValue: { title: active.prompt, html: active.html, tools: active.tools },
              toolCallId: active.id,
              searchCallId: active.id + '-search',
            }).events,
            responseCompleted(active.id),
          ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(createSse([responseCreated(active.id), ...events]))
      return true
    },
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const send = async prompt => {
        await control.command('fill', composer, { value: prompt })
        await control.command('clickWhenEnabled', ACTIVE_SEND_BUTTON_SELECTOR)
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: active.id + '-ready',
          timeoutMs: modelResponseTimeoutMs,
        })
      }
      await createSingleRootLocalProject(control, workspacePath, 'generated-interactions')
      await selectE2EModel(control)
      await send(active.prompt)
      const address = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        .workbench.currentRuntimeTask
      const findCall = async () =>
        readNativeToolCallId(
          control,
          address,
          block => block.mcpServer === 'wework_control' && block.toolInput?.title === active.prompt,
          active.prompt,
          uiTimeoutMs
        )
      const callId = await findCall()
      const appSelector = `[data-testid="mcp-app-slot"] [data-mcp-call-id="${callId}"]`
      const frameSelector = appSelector + ' [data-testid="mcp-app-frame"][data-ready="true"]'
      const origin = await control.command('getLocationOrigin', 'body')
      let frameUrl
      const selectFrame = async selector => {
        await control.command('waitFor', selector, { timeoutMs: modelResponseTimeoutMs })
        frameUrl = await control.command('getAttribute', selector, { value: 'src' })
      }
      const frameAction = async (action, selector, value, extra = {}) => {
        const response = await fetchLocalRuntime(
          control,
          `${origin}/wework/electron-host/v1/invoke`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              capability: 'e2e.mcpAppFrame',
              params: { url: frameUrl, action, selector, value, ...extra },
            }),
            timeoutMs: uiTimeoutMs,
          }
        )
        const result = await response.json()
        assert.equal(result.ok, true, JSON.stringify(result.error))
        return result.result
      }
      const textIs = (selector, text) =>
        waitForValue(
          () => frameAction('text', selector),
          value => value === text,
          `Generated HTML did not display ${text}`,
          uiTimeoutMs
        )
      await selectFrame(frameSelector)
      assert.equal(
        await control.command('getAttribute', appSelector, { value: 'data-display-mode' }),
        'inline'
      )
      await textIs('[data-testid="generated-save"]', 'Create schedule')
      const initialHeight = Number.parseFloat(
        await control.command('getComputedStyleValue', frameSelector, { value: 'height' })
      )
      let createdId
      let archiveAddress
      try {
        await control.command('scrollToBottomAsUser', SCROLLER_SELECTOR)
        const outer = () =>
          getSingleElementMetrics(control, SCROLLER_SELECTOR, 'Generated interaction conversation')
        const beforeWheel = await outer()
        const wheelInput = await frameAction(
          'wheel',
          '[data-testid="generated-prompt"]',
          undefined,
          {
            deltaY: -120,
          }
        )
        assert.equal(wheelInput.backend, 'chromium-input-dispatch')
        assert.notEqual(wheelInput.frameProcessId, wheelInput.mainFrameProcessId)
        const afterUp = await waitForValue(
          outer,
          metrics => metrics.scrollTop < beforeWheel.scrollTop - 20,
          'Wheel input over the form did not scroll the conversation upward',
          uiTimeoutMs
        )
        await frameAction('wheel', '[data-testid="generated-prompt"]', undefined, { deltaY: 120 })
        await waitForValue(
          outer,
          metrics => metrics.scrollTop > afterUp.scrollTop + 20,
          'Wheel input over the form did not scroll the conversation downward',
          uiTimeoutMs
        )
        await frameAction('fill', '[data-testid="generated-name"]', scheduleName)
        await frameAction(
          'fill',
          '[data-testid="generated-prompt"]',
          'Check the fixture without executing it'
        )
        await frameAction('click', '[data-testid="generated-save"]')
        await textIs('[data-testid="generated-status"]', 'Created')
        const items = (await rpc('runtime.automations.list', {})).items
        const created = items.filter(item => item.name === scheduleName)
        assert.equal(created.length, 1)
        createdId = created[0].id
        assert.equal(created[0].enabled, false)
        await textIs('[data-testid="generated-result"]', scheduleName + ' ' + createdId)
        await waitForValue(
          async () =>
            Number.parseFloat(
              await control.command('getComputedStyleValue', frameSelector, { value: 'height' })
            ),
          height => height < initialHeight,
          'Generated content did not shrink its placeholder',
          uiTimeoutMs
        )
        const restored = await rpc('runtime.mcp_apps.request', {
          address,
          callId,
          method: 'initialize',
        })
        assert.equal(restored.modelContext.structuredContent.state.createdId, createdId)
        const readyCount = control.readyCount
        await control.command('reloadMainWindow', 'body')
        await control.awaitReadyAfter(readyCount)
        await selectFrame(frameSelector)
        await textIs('[data-testid="generated-status"]', 'Created')
        await textIs('[data-testid="generated-result"]', scheduleName + ' ' + createdId)
        assert.equal(
          (await rpc('runtime.automations.list', {})).items.filter(
            item => item.name === scheduleName
          ).length,
          1
        )

        // Reopening must rebuild managed tools after the native process loses its live pool.
        await control.command('click', appSelector + ' [data-testid="mcp-app-close"]')
        await waitForValue(
          async () => JSON.parse(await control.command('restartLocalCodexAppServerIfIdle', 'body')),
          result => result.restarted === true,
          'The native app server did not become idle for cold interaction restoration',
          uiTimeoutMs
        )
        const coldReadyCount = control.readyCount
        await control.command('reloadMainWindow', 'body')
        await control.awaitReadyAfter(coldReadyCount)
        await selectFrame(frameSelector)
        await textIs('[data-testid="generated-status"]', 'Created')
        await textIs('[data-testid="generated-result"]', scheduleName + ' ' + createdId)
        assert.equal(
          (await rpc('runtime.automations.list', {})).items.filter(
            item => item.name === scheduleName
          ).length,
          1,
          'Cold restoration must not create another schedule'
        )

        const catalog = await rpc('runtime.runner.catalog', {})
        const model = catalog.models.find(item => item.runtime === 'codex' && item.is_default)
        assert.ok(model)
        const target = await rpc('runtime.tasks.create', {
          taskId: archiveTaskId,
          title: archivePrompt,
          runtime: 'codex',
          workspacePath,
          message: archivePrompt,
          executionRequest: {
            task_id: archiveTaskId,
            subtask_id: archiveTaskId + '-initial',
            user_id: 9001,
            prompt: archivePrompt,
            new_session: true,
            bot: [{ shell_type: 'Codex', name: 'Generated HTML archive target' }],
            model_config: {
              model_id: model.local_model_id,
              model_provider: model.provider,
              runtime_config: { codex: { use_user_config: true, configured: true } },
            },
          },
        })
        assert.equal(target.accepted, true)
        archiveAddress = { deviceId: target.deviceId, taskId: archiveTaskId, workspacePath }
        await waitForCompletedRuntimeTaskThread(control, archiveTaskId, modelResponseTimeoutMs)
        assert.equal((await rpc('runtime.tasks.archive', archiveAddress)).accepted, true)
        const history = await rpc('runtime.tasks.transcript', {
          address: archiveAddress,
          refresh: true,
        })
        assert.ok(history.messages.some(message => message.content === archivePrompt))
        const isArchived = async () =>
          (await rpc('runtime.archived_conversations.list', {})).items.some(
            item => item.taskId === archiveTaskId
          )
        assert.equal(await isArchived(), true, 'Reading history must preserve archive state')

        active = {
          prompt: resultsPrompt,
          id: 'generated-results',
          html: resultsHtml,
          tools: ['list_conversations', 'unarchive_conversation'],
        }
        await send(active.prompt)
        const resultsCallId = await findCall()
        assert.notEqual(resultsCallId, callId)
        await selectFrame(
          `[data-testid="mcp-app-slot"] [data-mcp-call-id="${resultsCallId}"] [data-testid="mcp-app-frame"][data-ready="true"]`
        )
        await frameAction('click', '[data-testid="generated-query"]')
        await waitForValue(
          () => frameAction('text', '[data-testid="generated-query-status"]'),
          value => /^Loaded [1-9]/.test(value),
          'The generated HTML did not query real conversations',
          uiTimeoutMs
        )
        const bindings = await rpc('runtime.mcp_apps.request', {
          address,
          callId: resultsCallId,
          method: 'tools/list',
        })
        assert.deepEqual(bindings.tools.map(tool => tool.name).sort(), [
          'list_conversations',
          'unarchive_conversation',
        ])
        const listTool = bindings.tools.find(tool => tool.name === 'list_conversations')
        const restoreTool = bindings.tools.find(tool => tool.name === 'unarchive_conversation')
        assert.deepEqual(listTool.outputSchema.required, [
          'items',
          'has_more',
          'next_cursor',
          'coverage',
        ])
        assert.equal(listTool.outputSchema.properties.items.items.type, 'object')
        assert.deepEqual(restoreTool.outputSchema.required, ['accepted'])
        await assert.rejects(
          () =>
            rpc('runtime.mcp_apps.request', {
              address,
              callId: resultsCallId,
              method: 'tools/call',
              params: { name: 'delete_automation', arguments: { automation_id: createdId } },
            }),
          /not available/
        )
        assert.equal(await isArchived(), true, 'Rendering HTML must not restore automatically')
        await frameAction('click', '[data-testid="generated-restore-' + archiveTaskId + '"]')
        await textIs('[data-testid="generated-query-status"]', 'Restored')
        assert.equal(await isArchived(), false)
        await control.command(
          'waitFor',
          '[data-testid="runtime-local-task-row-' + archiveTaskId + '"]'
        )
        const context = await rpc('runtime.mcp_apps.request', {
          address,
          callId: resultsCallId,
          method: 'initialize',
        })
        assert.equal(typeof context.modelContext.structuredContent.state.restoredId, 'string')
        await frameAction('click', '[data-testid="generated-open-' + archiveTaskId + '"]')
        await control.command(
          'waitFor',
          '[data-active-workbench-pane="true"] [data-testid="message-assistant"]',
          {
            text: archivePrompt,
          }
        )
        const opened = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
          .workbench.currentRuntimeTask
        assert.equal(opened.taskId, archiveTaskId)
        await control.command('navigate', 'body', {
          value:
            '/runtime-tasks?' +
            new URLSearchParams({
              deviceId: address.deviceId,
              taskId: address.taskId,
            }),
        })
        await selectFrame(
          '[data-testid="mcp-app-slot"] [data-mcp-call-id="' +
            resultsCallId +
            '"] [data-testid="mcp-app-frame"][data-ready="true"]'
        )
        await textIs('[data-testid="generated-open-' + archiveTaskId + '"]', 'Open conversation')
        await frameAction('click', '[data-testid="generated-navigation"]')
        await control.command('waitFor', '[data-testid="archived-conversations-settings-page"]')
      } finally {
        if (archiveAddress) {
          assert.equal((await rpc('runtime.tasks.archive', archiveAddress)).accepted, true)
          assert.equal(
            (await rpc('runtime.archived_conversations.delete', archiveAddress)).accepted,
            true
          )
        }
        if (createdId) {
          await rpc('runtime.automations.delete', { automationId: createdId })
          assert.equal(
            (await rpc('runtime.automations.list', {})).items.some(item => item.id === createdId),
            false
          )
        }
      }
    },
  }
}
