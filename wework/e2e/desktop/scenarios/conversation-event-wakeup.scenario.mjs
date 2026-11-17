import assert from 'node:assert/strict'
import { cp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopScenario as createBridgeScenario } from './stand-in-plugin-bridge.scenario.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import {
  createConversationEventModel,
  findEventFact as find,
} from '../modules/conversation-event-model.mjs'
import { modelRequestTexts } from '../modules/model-tool-output.mjs'
import { waitForBundledMarketplaceRegistration } from '../modules/plugin-flows.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'
import { setNativeCatalogOverride } from '../modules/model-catalog-recovery.mjs'
import { createEventHumanWait } from '../modules/conversation-event-human-wait.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_SEND_BUTTON_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'
import {
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const MARKER = 'WEWORK_CONVERSATION_EVENT'
const PROVIDER = '@test/connection-source/records'

export function createDesktopScenario(options) {
  const base = createBridgeScenario(options)
  const {
    resultDir,
    electronUserDataDirectory,
    workspacePath,
    uiTimeoutMs,
    modelResponseTimeoutMs,
    workbenchReadyTimeoutMs,
    captureScreenshot,
    restartDesktopApp,
  } = options
  let codexHome
  let active = false
  let phase = 'ordinary'
  let modelRequests = 0
  let cancellationEvidence = null
  let questionOutput
  let sequence = 0
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const codex = (control, method, params) =>
    rpc(control, 'runtime.codex.app_server.request', { method, params })
  const recordsPath = join(resultDir, 'records.json')
  const human = createEventHumanWait({ ...options, rpc })
  const { events: modelEvents, completed } = createConversationEventModel({
    markerPrefix: MARKER,
    providerId: PROVIDER,
    onEvent: () => human.eventStarted(),
    onQuestion: output => {
      questionOutput = output
    },
  })
  let events = []
  const saveEvents = () =>
    writeFile(
      recordsPath,
      JSON.stringify(
        ['archive-record', 'long-archive-record'].map(id => ({ id, value: JSON.stringify(events) }))
      )
    )
  const event = (id, text, topicId = 'release-document') => ({
    id,
    eventType: 'message.received',
    topicId,
    text,
    at: new Date().toISOString(),
  })

  return {
    async prepareApp(context) {
      await base.prepareApp(context)
      codexHome = context.codexHome
      await saveEvents()
      for (const adapter of [
        join(resultDir, 'connection-adapter'),
        join(
          electronUserDataDirectory,
          'dsh-core/profiles/wework-core/node_modules/@test/connection-source'
        ),
      ]) {
        await cp(
          new URL('../fixtures/conversation-events-provider.mjs', import.meta.url),
          join(adapter, 'index.js')
        )
      }
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
      if (!modelRequestTexts(body).includes(MARKER)) return false
      modelRequests++
      const held = phase === 'human' ? human.intercept(modelRequestTexts(body), response) : null
      if (held) return held
      const id = `conversation-event-${++sequence}`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        createSse([responseCreated(id), ...modelEvents(body, phase), responseCompleted(id)])
      )
      return true
    },
    async verify(control) {
      await control.command('ensureLocalModelCatalogReady', 'body', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await setNativeCatalogOverride(
        control,
        DEFAULT_MODEL_ID,
        {
          experimental_supported_tools: ['request_user_input_async'],
        },
        workbenchReadyTimeoutMs
      )
      await waitForBundledMarketplaceRegistration(codexHome)
      await codex(control, 'marketplace/add', { source: join(resultDir, 'connection-marketplace') })
      await rpc(control, 'runtime.connections.dependencies.install', {
        providerId: PROVIDER,
        aliases: ['source'],
      })
      await createSingleRootLocalProject(control, workspacePath, 'conversation-events')
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      active = true
      let originalAddress
      try {
        for (const story of ['ordinary', 'goal', 'human', 'cancel', 'pause']) {
          phase = story
          await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
            value: `${MARKER}_${phase} ${phase === 'ordinary' ? '' : '请创建持续目标，'}请订阅文档变化并在变化后继续。`,
          })
          await control.command('waitFor', ACTIVE_SEND_BUTTON_SELECTOR, { enabled: true })
          await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
          if (phase === 'human') {
            assert.ok(originalAddress)
            await waitForValue(
              () => rpc(control, 'runtime.tasks.get', { address: originalAddress }),
              result => result.task.interactionStatus === 'awaitingUserReply',
              'The real native question must be pending before the human-wait story proceeds',
              modelResponseTimeoutMs
            )
            await control.command(
              'waitFor',
              `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="request-user-input-card"]`,
              { timeoutMs: modelResponseTimeoutMs }
            )
          }
          await control.command(
            'waitFor',
            `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
            { text: `${MARKER}_${phase}_WAITING`, timeoutMs: modelResponseTimeoutMs }
          )
          await control.command('waitFor', '[data-testid="connection-event-status"]', {
            text: '发布文档',
          })
          const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
          const address = debug.workbench.currentRuntimeTask
          assert.ok(address?.taskId)
          if (!originalAddress) originalAddress = address
          assert.equal(address.taskId, originalAddress.taskId)
          assert.equal(address.workspacePath, originalAddress.workspacePath)
          const getTask = () => rpc(control, 'runtime.tasks.get', { address })
          await waitForValue(
            getTask,
            result => !result.task.running,
            'Subscription setup must finish its model turn',
            modelResponseTimeoutMs
          )
          if (phase === 'human') await human.prepare(control, getTask)
          const requestsBefore = modelRequests
          const before = await getTask()
          await captureScreenshot(control, `conversation-event-${phase}-waiting.png`)
          if (phase === 'goal') {
            const goal = await rpc(control, 'runtime.tasks.goal.get', { address })
            assert.equal(goal.goal.status, 'blocked')
            assert.equal(goal.goal.tokenBudget, 20000)
            await control.command('waitFor', '[data-testid="goal-status-bar"]', {
              text: '等待事件',
            })
            assert.equal(typeof restartDesktopApp, 'function')
            const restartAt = Date.now()
            await restartDesktopApp()
            await control.command(
              'waitFor',
              `[data-testid="runtime-local-task-row-${address.taskId}"]`,
              { timeoutMs: workbenchReadyTimeoutMs }
            )
            await control.command(
              'click',
              `[data-testid="runtime-local-task-row-${address.taskId}"]`
            )
            await control.command('waitFor', '[data-testid="connection-event-status"]', {
              text: '发布文档',
            })
            const restored = await rpc(control, 'runtime.tasks.goal.get', { address })
            assert.equal(restored.goal.status, 'blocked')
            assert.equal(restored.goal.createdAt, goal.goal.createdAt)
            assert.equal(restored.goal.tokenBudget, goal.goal.tokenBudget)
            await waitForValue(
              getTask,
              result =>
                result.task.runtimeHandle?.connectionEventSubscriptions?.some(
                  item =>
                    item.subscription_key === `${MARKER}_${phase}` &&
                    !item.error_code &&
                    item.last_collected_at >= restartAt
                ),
              'Restarted connection host must successfully collect before healthy recovery is recorded',
              30000
            )
            const direct = await getTask()
            const listed = await rpc(control, 'runtime.tasks.list', {})
            const summarized = value => {
              const task = find(value, item => item.taskId === address.taskId && item.runtimeHandle)
              return task
                ? {
                    taskId: task.taskId,
                    revision: task.executionState?.revision,
                    subscriptions: task.runtimeHandle.connectionEventSubscriptions?.map(item => ({
                      status: item.status,
                      hasError: Boolean(item.error_code),
                      lastCollectedAt: item.last_collected_at,
                    })),
                  }
                : null
            }
            await writeFile(
              join(resultDir, 'event-recovery-projections.json'),
              JSON.stringify({ direct: summarized(direct), listed: summarized(listed) }, null, 2)
            )
            await control.command('waitFor', '[data-testid="connection-event-status"]', {
              text: '等待事件，到达后自动继续',
            })
            await captureScreenshot(control, 'conversation-event-goal-restored.png')
          }
          if (phase === 'cancel') {
            await control.command('click', '[data-testid="cancel-connection-event-subscription"]')
            await waitForValue(
              getTask,
              result =>
                !result.task.runtimeHandle?.connectionEventSubscriptions?.some(
                  item => item.subscription_key === `${MARKER}_${phase}`
                ),
              'Native cancellation must remove the exact subscription',
              uiTimeoutMs
            )
            await control.command('waitFor', '[data-testid="connection-event-status"]', {
              visible: false,
            })
            await captureScreenshot(control, 'conversation-event-cancelled.png')
            const goalBefore = await rpc(control, 'runtime.tasks.goal.get', { address })
            assert.equal(
              goalBefore.goal.status,
              'blocked',
              'Cancelling a watch must not resume or pause its Goal'
            )
            await restartDesktopApp()
            await control.command(
              'waitFor',
              `[data-testid="runtime-local-task-row-${address.taskId}"]`,
              { timeoutMs: workbenchReadyTimeoutMs }
            )
            await control.command(
              'click',
              `[data-testid="runtime-local-task-row-${address.taskId}"]`
            )
            await control.command(
              'waitFor',
              `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
              { text: `${MARKER}_${phase}_WAITING`, timeoutMs: modelResponseTimeoutMs }
            )
            await control.command('waitFor', '[data-testid="connection-event-status"]', {
              visible: false,
            })
            await control.command('waitFor', '[data-testid="goal-status-bar"]', {
              text: '受阻',
            })
            assert.ok(
              !(await getTask()).task.runtimeHandle?.connectionEventSubscriptions?.some(
                item => item.subscription_key === `${MARKER}_${phase}`
              ),
              'A cancelled watch must remain cancelled after a real desktop restart'
            )
            await captureScreenshot(control, 'conversation-event-cancelled-after-restart.png')
            events.push(event(`${phase}-event`, `${MARKER}_${phase}_EVENT_RECEIVED`))
            await saveEvents()
            // Verify a full collection interval after the event that used to match.
            const deadline = Date.now() + 17000
            while (Date.now() < deadline) {
              assert.equal(
                modelRequests,
                requestsBefore,
                'A cancelled watch must never wake the model'
              )
              await new Promise(resolve => setTimeout(resolve, 100))
            }
            const goalAfter = await rpc(control, 'runtime.tasks.goal.get', { address })
            assert.equal(goalAfter.goal.status, goalBefore.goal.status)
            assert.equal(goalAfter.goal.createdAt, goalBefore.goal.createdAt)
            assert.equal((await getTask()).task.threadId, before.task.threadId)
            cancellationEvidence = {
              taskId: address.taskId,
              threadId: before.task.threadId,
              modelRequestsBefore: requestsBefore,
              modelRequestsAfter: modelRequests,
              goalStatusBefore: goalBefore.goal.status,
              goalStatusAfter: goalAfter.goal.status,
              goalCreatedAtBefore: goalBefore.goal.createdAt,
              goalCreatedAtAfter: goalAfter.goal.createdAt,
              cancelledAfterRestart: true,
            }
            await rpc(control, 'runtime.tasks.goal.clear', { address })
            continue
          }
          if (phase === 'pause') {
            await control.command('click', '[data-testid="pause-goal-button"]')
            await control.command('waitFor', '[data-testid="connection-event-status"]', {
              visible: false,
            })
          }
          // A negative observation window verifies that unrelated events and a
          // user pause never start model turns. This is not a UI readiness delay.
          events.push(event(`${phase}-ignored`, 'Unrelated document signal', 'unrelated-document'))
          await saveEvents()
          if (phase !== 'pause') {
            await waitForValue(
              getTask,
              result =>
                result.task.runtimeHandle?.connectionEventSubscriptions?.some(
                  item =>
                    item.subscription_key === `${MARKER}_${phase}` && item.observed_events >= 1
                ),
              'The host must process the unrelated event before the negative observation',
              30000
            )
          }
          const deadline = Date.now() + (phase === 'pause' ? 17000 : 1500)
          while (Date.now() < deadline) {
            assert.equal(modelRequests, requestsBefore, 'Waiting must not poll through model turns')
            await new Promise(resolve => setTimeout(resolve, 100))
          }
          const match = event(`${phase}-event`, `${MARKER}_${phase}_EVENT_RECEIVED`)
          events.push(match, match)
          await saveEvents()
          if (phase === 'human')
            await human.verifyPending(
              control,
              address,
              getTask,
              requestsBefore,
              () => modelRequests
            )
          if (phase === 'pause') {
            const deadline = Date.now() + 17000
            while (Date.now() < deadline) {
              assert.equal(
                modelRequests,
                requestsBefore,
                'A user pause must suppress event wakeups'
              )
              await new Promise(resolve => setTimeout(resolve, 100))
            }
            await captureScreenshot(control, 'conversation-event-paused.png')
            break
          }
          await control.command(
            'waitFor',
            `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
            { text: `${MARKER}_${phase}_DONE`, timeoutMs: 30000 }
          )
          const after = await getTask()
          assert.equal(
            after.task.threadId,
            before.task.threadId,
            'The event must resume the original native thread'
          )
          await control.command('waitFor', '[data-testid="connection-event-status"]', {
            visible: false,
          })
          const deliveryNote = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="connection-event-message"]`
          await control.command('waitFor', deliveryNote, { text: '发布文档' })
          const deliveryText = await control.command('getText', deliveryNote)
          assert.match(deliveryText, /发布文档/)
          assert.doesNotMatch(deliveryText, /Wework connection event delivery|"events"\s*:/)
          await captureScreenshot(control, `conversation-event-${phase}-resumed.png`)
          assert.ok(completed.has(phase))
          if (['goal', 'human'].includes(phase)) {
            const goal = await rpc(control, 'runtime.tasks.goal.get', { address })
            assert.equal(goal.goal.status, 'complete')
            assert.equal(goal.goal.tokenBudget, 20000)
          }
          if (phase === 'human') await human.cleanup(control)
        }
        await writeFile(
          join(resultDir, 'conversation-event-evidence.json'),
          JSON.stringify(
            {
              modelRequests,
              phases: [...completed],
              taskId: originalAddress.taskId,
              cancellationEvidence,
            },
            null,
            2
          )
        )
      } finally {
        await human.cleanup(control)
      }
    },
    cleanup() {
      human.release()
    },
    diagnostics() {
      return { phase, modelRequests, questionOutput }
    },
  }
}
