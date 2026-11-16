import { selectedToolCall } from '../modules/model-tool-calls.mjs'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import {
  createSingleRootLocalProject,
  selectE2EModel,
  withTimeout,
  DEFAULT_MODEL_ID,
} from '../modules/shared.mjs'
import {
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  streamingTextEvents,
  assistantMessage,
  responseCreated,
  responseCompleted,
  requestAdvertisesProgrammaticExec,
  selectProgrammaticExec,
  customToolCall,
  requestContainsToolOutput,
} from '../modules/response-protocol.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'
import { waitForBottomMetrics, waitForElementWidth } from '../modules/conversation-layout.mjs'
import { waitForEmbeddedBrowserVisibility } from '../modules/embedded-browser-visibility.mjs'
import { runtimeTransportGates } from '../modules/runtime-transport-gates.mjs'
import { followUpAgentHistory } from '../modules/follow-up-agent-history.mjs'

const BASE = 'WEWORK_FOLLOW_UP_SWITCH_BASE'
const OTHER = 'WEWORK_FOLLOW_UP_SWITCH_OTHER'
const OTHER_INITIAL = 'WeworkOtherCompletedHistory'
const FOLLOW_UP =
  'WeworkFollowUpSwitchGoal\n\n1. 项目负责人和协作小组负责人的关系是什么？请统一设计并整理实现。\n2. 日历入口是否应该放在项目空间中？请检查当前交互。\n3. 从完整用户故事出发验证核心流程，解决发现的问题。'
const PROGRESS = 'WEWORK_FOLLOW_UP_WORKING'
const CALL_ID = 'follow-up-held-command'
const HISTORY_ROUNDS = 12
const FOLLOW_UP_WINDOW_SIZE = { width: 1152, height: 648 }
const ACTIVE_WORKBENCH_SELECTOR =
  '[data-workspace-tab-content][aria-hidden="false"] [data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const ACTIVE_COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`
const ACTIVE_SEND_BUTTON_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`

async function waitForReadableFollowUp(control, description, marker = FOLLOW_UP.split('\n')[0]) {
  const id = await control.command(
    'getAttribute',
    `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`,
    {
      text: marker,
      value: 'data-message-id',
    }
  )
  const selector = `${ACTIVE_WORKBENCH_SELECTOR} [data-message-id=${JSON.stringify(id)}]`
  const deadline = Date.now() + 10_000
  let measurements
  while (Date.now() < deadline) {
    const read = async target => JSON.parse(await control.command('getElementMetrics', target))[0]
    measurements = {
      user: await read(selector),
      viewport: await read(
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-content"]`
      ),
      composer: await read(
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-floating-composer-layer"]`
      ),
    }
    const { user, viewport, composer } = measurements
    if (
      user &&
      viewport &&
      composer &&
      viewport.viewportWidth === FOLLOW_UP_WINDOW_SIZE.width &&
      viewport.viewportHeight === FOLLOW_UP_WINDOW_SIZE.height &&
      user.top >= viewport.top - 2 &&
      user.bottom <= composer.top + 2
    )
      return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(`${description}: ${JSON.stringify(measurements)}`)
}

function heldExecutionProgram(workspacePath, startedFile, releaseFile, progress) {
  const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(startedFile)},'started');console.log('${progress}');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseFile)})){clearInterval(timer);process.exit(0)}},50)`
  const cmd = `node -e "eval(Buffer.from('${Buffer.from(script).toString('base64')}','base64').toString('utf8'))"`
  return `// @exec: {"yield_time_ms": 120000}\nlet execution = await tools.exec_command(${JSON.stringify({ cmd, workdir: workspacePath, yield_time_ms: 30000 })});\nwhile(execution.session_id) execution = await tools.write_stdin({session_id:execution.session_id,chars:"",yield_time_ms:30000});\ntext(execution)`
}

function writeToolResponse(body, response, callId, program, text) {
  const tool = selectProgrammaticExec(body, program)
  const event = selectedToolCall(callId, { codeMode: tool }).at(-1)
  const progress = assistantMessage(text)
  progress.item.phase = 'commentary'
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.end(createSse([responseCreated(callId), progress, event, responseCompleted(callId)]))
}

// Keep the real tool running after commentary and a plan update. Sidebar task
// navigation must preserve the accepted request without waiting for more output.
export function createDesktopScenario(options) {
  const agentHistory = followUpAgentHistory(
    options,
    ACTIVE_WORKBENCH_SELECTOR,
    heldExecutionProgram
  )
  let releaseModel
  let baseRequests = 0
  let releaseBase
  let baseStarted
  let toolRequested = false
  let otherRequests = 0
  let releaseOther
  let releaseOtherProgress
  let otherProgressWritten
  const otherHeld = new Promise(resolve => {
    releaseOther = resolve
  })
  const otherProgress = new Promise(resolve => {
    releaseOtherProgress = resolve
  })
  const otherUpdated = new Promise(resolve => {
    otherProgressWritten = resolve
  })
  const releaseOtherFile = join(options.workspacePath, 'other-command-release')
  const startedOtherFile = join(options.workspacePath, 'other-command-started')
  const releaseFile = join(options.workspacePath, 'follow-up-command-release')
  const startedFile = join(options.workspacePath, 'follow-up-command-started')
  let commandReturned = false
  const baseHeld = new Promise(resolve => {
    releaseBase = resolve
  })
  const baseContinuation = new Promise(resolve => {
    baseStarted = resolve
  })
  const held = new Promise(resolve => {
    releaseModel = resolve
  })
  let released = false
  return {
    diagnostics: () => ({ reusedAgent: agentHistory.diagnostics() }),
    codexConfigToml: '\n[features.multi_agent_v2]\nenabled = true\n',
    async handleHttp(request, response, url) {
      if (url.pathname === '/follow-up-browser-fixture') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end('<!doctype html><title>Execution browser</title><h1>Execution browser</h1>')
        return true
      }
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (await agentHistory.handle(request, body, response)) return true
      const serialized = JSON.stringify(body)
      if (serialized.includes(OTHER_INITIAL) && !serialized.includes(OTHER)) {
        const id = 'other-completed-history'
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end(
          createSse([
            responseCreated(id),
            assistantMessage(`${OTHER_INITIAL}_ANSWER`),
            responseCompleted(id),
          ])
        )
        return true
      }
      if (serialized.includes(OTHER)) {
        const round = ++otherRequests
        if (round === 1) {
          writeToolResponse(
            body,
            response,
            'other-context-ready',
            'text("OTHER_CONTEXT_READY")',
            `${OTHER}_ANSWER`
          )
        } else if (round === 2) {
          await Promise.race([
            otherProgress,
            new Promise(resolve => response.once('close', resolve)),
          ])
          if (response.destroyed) return true
          writeToolResponse(
            body,
            response,
            'other-held-command',
            heldExecutionProgram(
              options.workspacePath,
              startedOtherFile,
              releaseOtherFile,
              `${OTHER}_UPDATED`
            ),
            `${OTHER}_UPDATED`
          )
          otherProgressWritten()
        } else {
          await Promise.race([otherHeld, new Promise(resolve => response.once('close', resolve))])
          if (response.destroyed) return true
          response.writeHead(200, { 'Content-Type': 'text/event-stream' })
          response.end(
            createSse([
              responseCreated('other-final'),
              assistantMessage(`${OTHER}_COMPLETE`),
              responseCompleted('other-final'),
            ])
          )
        }
        return true
      }
      const goal = serialized.includes(FOLLOW_UP.split('\n')[0])
      if (goal && !toolRequested) {
        toolRequested = true
        const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(startedFile)},'started');console.log('${PROGRESS}');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseFile)})){clearInterval(timer);process.exit(0)}},50)`
        const command = `node -e "eval(Buffer.from('${Buffer.from(script).toString('base64')}','base64').toString('utf8'))"`
        assert.ok(
          requestAdvertisesProgrammaticExec(body),
          'The regression must exercise the real programmatic exec tool'
        )
        const tool = selectProgrammaticExec(
          body,
          `// @exec: {"yield_time_ms": 120000}\ntext(await tools.update_plan({plan:[{step:"检查项目负责人及日历入口",status:"in_progress"},{step:"验证完整用户故事",status:"pending"}]}));\nlet execution = await tools.exec_command(${JSON.stringify({ cmd: command, workdir: options.workspacePath, yield_time_ms: 30000 })});\nwhile (execution.session_id) execution = await tools.write_stdin({session_id:execution.session_id,chars:"",yield_time_ms:30000});\ntext(execution)`
        )
        const event = selectedToolCall(CALL_ID, { codeMode: tool }).at(-1)
        const calls = [event]
        const progress = assistantMessage(PROGRESS)
        progress.item.phase = 'commentary'
        const id = 'follow-up-tool-response'
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end(createSse([responseCreated(id), progress, ...calls, responseCompleted(id)]))
        return true
      }
      if (goal) {
        commandReturned = true
        assert.ok(
          requestContainsToolOutput(body, CALL_ID),
          'The follow-up must execute its real command before navigation'
        )
      }
      const base = !goal && !serialized.includes(OTHER)
      const round = base ? ++baseRequests : 0
      assert.ok(round <= HISTORY_ROUNDS, 'The completed Goal must not start another automatic turn')
      const text = goal
        ? `${FOLLOW_UP}_ANSWER`
        : serialized.includes(OTHER)
          ? `${OTHER}_ANSWER\n${OTHER}_UPDATED`
          : `${BASE}_ANSWER\n\n${Array.from({ length: 12 }, (_, index) => `Completed turn ${round}, paragraph ${index}. ${'The completed work remains available in the conversation history. '.repeat(5)}`).join('\n\n')}`
      assert.ok(goal || serialized.includes(BASE) || serialized.includes(OTHER))
      const stream = streamingTextEvents(`follow-up-switch-${Date.now()}`, text, 'final_answer')
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(createSse(stream.start))
      if (base && round < HISTORY_ROUNDS) {
        // Exceed the native 500-item latest-page budget and the virtual viewport.
        // Every item is produced and persisted by the real Codex model protocol.
        response.write(
          createSse(
            Array.from({ length: 100 }, (_, index) => ({
              type: 'response.output_item.done',
              output_index: index,
              item: {
                id: `follow-up-history-${round}-${index}`,
                type: 'message',
                role: 'assistant',
                phase: 'commentary',
                content: [
                  {
                    type: 'output_text',
                    text: `${BASE} progress ${index}\n\n${'History detail. '.repeat(40)}`,
                    annotations: [],
                  },
                ],
              },
            }))
          )
        )
      }
      if (base && round === HISTORY_ROUNDS) {
        baseStarted()
        await Promise.race([baseHeld, new Promise(resolve => response.once('close', resolve))])
        if (response.destroyed) return true
      }
      if (goal) {
        await Promise.race([held, new Promise(resolve => response.once('close', resolve))])
        if (response.destroyed) return true
      }
      response.write(
        createSse([
          {
            type: 'response.output_text.delta',
            item_id: stream.itemId,
            output_index: 0,
            content_index: 0,
            delta: !base && !goal ? `${OTHER}_ANSWER` : text,
          },
        ])
      )
      response.end(createSse(stream.finish))
      return true
    },
    async verify(control) {
      let address
      let otherAddress
      let previousWindowSize
      const send = async text => {
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: text })
        await control.command('waitFor', ACTIVE_SEND_BUTTON_SELECTOR, { enabled: true })
        await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
      }
      const createTask = async text => {
        await send(text)
        const state = await waitForWorkbenchDebugState(
          control,
          snapshot =>
            Boolean(snapshot.workbench?.currentRuntimeTask) &&
            snapshot.workbench.currentRuntimeTask.taskId !== address?.taskId &&
            !snapshot.pane?.status?.isBusy,
          'The other task must start before navigation'
        )
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          { text: `${text}_ANSWER` }
        )
        return state.workbench.currentRuntimeTask
      }
      try {
        // Keep the first-launch-size regression independent of the shared large-window fixture.
        previousWindowSize = JSON.parse(
          await control.command('setMainWindowSize', 'body', {
            value: JSON.stringify(FOLLOW_UP_WINDOW_SIZE),
          })
        )
        await createSingleRootLocalProject(control, options.workspacePath, 'follow-up-task-switch')
        await selectE2EModel(control)
        const { models } = await requestExecutor(
          control,
          'runtime.codex.catalog.overrides.read',
          { slugs: [DEFAULT_MODEL_ID] },
          options.uiTimeoutMs
        )
        const model = models.find(candidate => candidate.slug === DEFAULT_MODEL_ID)
        assert.ok(model, 'The fixture model must have a native catalog entry')
        await requestExecutor(
          control,
          'runtime.codex.catalog.overrides.write',
          {
            slug: DEFAULT_MODEL_ID,
            entry: { ...model.effective, tool_mode: 'code_mode' },
          },
          options.uiTimeoutMs
        )
        await control.command('restartLocalCodexAppServerIfIdle', 'body')
        await control.command(
          'click',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="add-context-button"]`
        )
        await control.command('click', '[data-testid="set-goal-button"]')
        await send(BASE)
        await withTimeout(
          baseContinuation,
          options.workbenchReadyTimeoutMs,
          'The initial Goal did not build its continuation history'
        )
        address = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).workbench
          .currentRuntimeTask
        await requestExecutor(
          control,
          'runtime.tasks.goal.set',
          { address, status: 'complete' },
          options.uiTimeoutMs
        )
        releaseBase()
        await waitForWorkbenchDebugState(
          control,
          snapshot => !snapshot.pane?.status?.isBusy,
          'The initial Goal must finish before sending another Goal'
        )
        await options.restartDesktopApp()
        await control.command(
          'waitFor',
          `[data-testid="runtime-local-task-row-${address.taskId}"]`,
          {
            timeoutMs: options.workbenchReadyTimeoutMs,
          }
        )
        await control.command('click', `[data-testid="runtime-local-task-row-${address.taskId}"]`)
        await waitForWorkbenchDebugState(
          control,
          snapshot =>
            snapshot.workbench?.currentRuntimeTask?.taskId === address.taskId &&
            !snapshot.pane?.transcript?.loading &&
            snapshot.pane?.messageSummary?.total > 0,
          'The historical task must load its latest native page after restart'
        )
        await control.command('click', '[data-testid="new-chat-button"]')
        const other = await createTask(OTHER_INITIAL)
        otherAddress = other
        await control.command(
          'click',
          '[data-workspace-tab-portal-owner]:not([hidden]) [data-testid="toggle-right-workspace-panel-button"]'
        )
        await control.command('click', '[data-testid="right-workspace-browser-option"]')
        const browserInput = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-browser-url-input"]`
        await control.command('waitFor', browserInput)
        await control.command('fill', browserInput, {
          value: `${control.url}/follow-up-browser-fixture`,
        })
        await control.command('submit', browserInput)
        const browserHost = '[data-testid="workspace-browser-electron-webview"]'
        await control.command('waitFor', browserHost)
        const browserLabel = await control.command('getAttribute', browserHost, {
          value: 'data-wework-browser-webview',
        })
        await waitForEmbeddedBrowserVisibility(
          control,
          browserLabel,
          true,
          options.uiTimeoutMs,
          'The real execution browser must load'
        )
        const chatViewport = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-content"]`
        const [wideChat] = JSON.parse(await control.command('getElementMetrics', chatViewport))
        await control.command('dragBy', '[data-testid="right-workspace-resize-handle"]', {
          value: JSON.stringify({ x: 384 - wideChat.width, y: 0 }),
        })
        await waitForElementWidth(
          control,
          chatViewport,
          width => width <= 400,
          'The execution conversation must be narrow beside the browser'
        )
        assert.notEqual(other.taskId, address.taskId, 'The switch target must be a separate task')
        const row = task => `[data-testid="runtime-local-task-row-${task.taskId}"]`
        const page = await requestExecutor(
          control,
          'runtime.tasks.transcript',
          { address, limit: 5 },
          options.uiTimeoutMs
        )
        assert.ok(page.beforeCursor, 'The native history fixture must exceed one page')
        await control.command('click', row(address))
        const gates = runtimeTransportGates(control)
        await gates.arm({
          id: 'background-turn-start',
          kind: 'event',
          name: 'runtime.turn.updated',
          holdFollowing: true,
          where: [
            { path: 'payload.taskId', equals: other.taskId },
            { path: 'payload.data.status', equals: 'started' },
          ],
        })
        await requestExecutor(
          control,
          'runtime.tasks.goal.set',
          { address: other, objective: OTHER, status: 'active' },
          options.uiTimeoutMs
        )
        await gates.wait('background-turn-start')
        releaseOtherProgress()
        await withTimeout(
          otherUpdated,
          options.uiTimeoutMs,
          'The other task must stream while the original task is visible'
        )
        await waitForWorkbenchDebugState(
          control,
          () => existsSync(startedOtherFile),
          'The background command must start before reopening its retained pane'
        )
        const nativeOther = await requestExecutor(
          control,
          'runtime.tasks.transcript',
          { address: other, limit: 5 },
          options.uiTimeoutMs
        )
        assert.ok(
          nativeOther.turns.some(turn =>
            turn.items.some(
              item => item.type === 'block' && item.block?.content?.includes(`${OTHER}_UPDATED`)
            )
          ),
          'Native history must contain background progress before the retained pane opens'
        )
        await control.command('click', row(other))
        await control.command(
          'scrollToBottomAsUser',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-content"]`
        )
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          { text: `${OTHER}_UPDATED`, visible: true }
        )
        await gates.reset()
        await control.command('click', row(address))
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          { text: `${BASE}_ANSWER` }
        )
        await waitForBottomMetrics(
          control,
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-content"]`,
          'The restored history must settle before changing its viewport',
          options.uiTimeoutMs
        )
        await control.command('click', '[data-testid="toggle-bottom-workspace-panel-button"]')
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="workspace-terminal-window"]`
        )
        await control.command('click', '[data-testid="toggle-bottom-workspace-panel-button"]')
        await control.command(
          'click',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="add-context-button"]`
        )
        await control.command('click', '[data-testid="set-goal-button"]')
        const beforeSend = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        assert.equal(
          beforeSend.pane?.messageSummary?.byRole?.user ?? 0,
          0,
          'The restored page must contain only automatic Goal replies'
        )
        await control.command(
          'scrollFromBottomAsUser',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-content"]`,
          { value: '240' }
        )
        await send(FOLLOW_UP)
        await waitForWorkbenchDebugState(
          control,
          () => existsSync(startedFile),
          'The real follow-up command must start before task navigation'
        )
        assert.equal(
          commandReturned,
          false,
          'The switch must happen before the pending tool returns'
        )
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          { text: PROGRESS }
        )
        await control.command('click', row(other))
        await waitForWorkbenchDebugState(
          control,
          snapshot => snapshot.workbench?.currentRuntimeTask?.taskId === other.taskId,
          'The sidebar must switch to the other task'
        )
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          { text: `${OTHER}_ANSWER` }
        )
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          { text: `${OTHER}_UPDATED`, visible: true }
        )
        await control.command('click', row(address))
        await waitForWorkbenchDebugState(
          control,
          snapshot =>
            snapshot.workbench?.currentRuntimeTask?.taskId === address.taskId &&
            !snapshot.pane?.transcript?.loading,
          'The original task transcript must finish loading'
        )
        assert.equal(released, false, 'The assertion must precede the final model answer')
        assert.equal(
          commandReturned,
          false,
          'The reopened request must not wait for tool completion'
        )
        const transcript = await requestExecutor(
          control,
          'runtime.tasks.transcript',
          { address, limit: 5 },
          options.uiTimeoutMs
        )
        assert.ok(
          transcript.turns.some(turn =>
            turn.items.some(
              item => item.type === 'user_message' && item.message.content === FOLLOW_UP
            )
          ),
          'Native task history must include the accepted follow-up before the final assistant answer'
        )
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-user"]`,
          { text: FOLLOW_UP.split('\n')[0], visible: true }
        )
        await waitForReadableFollowUp(
          control,
          'The reopened follow-up must be inside the conversation above the composer'
        )
        await control.command(
          'scrollFromBottomAsUser',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-content"]`,
          { value: '300' }
        )
        await control.command(
          'scrollToBottomAsUser',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-content"]`
        )
        await waitForReadableFollowUp(control, 'Scrolling down must reach the latest follow-up')
        await agentHistory.verify(control, otherAddress)
      } catch (error) {
        const diagnostics = { error: String(error) }
        for (const [key, action, selector] of [
          ['workbench', 'getWorkbenchDebugSnapshot', 'body'],
          [
            'viewport',
            'getElementMetrics',
            `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="desktop-workbench-content"]`,
          ],
          ['rows', 'getElementMetrics', `${ACTIVE_WORKBENCH_SELECTOR} [data-message-row]`],
        ]) {
          try {
            diagnostics[key] = await control.command(action, selector)
          } catch (failure) {
            diagnostics[key] = String(failure)
          }
        }
        await writeFile(
          join(options.resultDir, 'follow-up-switch-failure.json'),
          JSON.stringify(diagnostics, null, 2)
        )
        throw error
      } finally {
        try {
          await runtimeTransportGates(control).reset()
          if (otherAddress)
            await requestExecutor(
              control,
              'runtime.tasks.goal.clear',
              { address: otherAddress },
              options.uiTimeoutMs
            )
          if (address)
            await requestExecutor(
              control,
              'runtime.tasks.goal.clear',
              { address },
              options.uiTimeoutMs
            )
        } finally {
          released = true
          await writeFile(releaseFile, 'release')
          await writeFile(releaseOtherFile, 'release')
          releaseBase()
          releaseModel()
          releaseOtherProgress()
          releaseOther()
          if (previousWindowSize)
            await control.command('setMainWindowSize', 'body', {
              value: JSON.stringify(previousWindowSize),
            })
        }
      }
    },
  }
}
