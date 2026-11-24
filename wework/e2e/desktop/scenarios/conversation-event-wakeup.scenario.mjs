import assert from 'node:assert/strict'
import { cp, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createDesktopScenario as createBridgeScenario } from './stand-in-plugin-bridge.scenario.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import {
  createConversationEventModel,
  findEventFact as find,
  PREEXISTING_CHECKS_HEAD,
  PREEXISTING_CHECKS_TOPIC,
  WORKFLOW_CONFLICT_TOPIC,
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
  MODEL_PROVIDER_ID,
  createSingleRootLocalProject,
  selectE2EModel,
} from '../modules/shared.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const MARKER = 'WEWORK_CONVERSATION_EVENT'
const PROVIDER = '@test/connection-source/records'
const CONTROL_MCP_IDLE_TTL_MS = 1000

function latestWaitingSubscriptions(body) {
  const snapshot = body.input.findLast(
    item =>
      item.type === 'message' &&
      item.role === 'user' &&
      item.content?.[0]?.text === '[tool_result without a matching tool_call]'
  )
  assert.ok(snapshot, 'The model must receive a waiting subscription snapshot')
  assert.equal(snapshot.content[1]?.type, 'input_text', 'The snapshot must be model-visible text')
  return JSON.parse(snapshot.content[1].text)
}

export function createDesktopScenario(options, { controlContextOnly = false } = {}) {
  const base = createBridgeScenario(options, { versionedEventTypes: ['git.event'] })
  const {
    resultDir,
    electronUserDataDirectory,
    executorHome,
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
  let busyResponse
  let busyStarted = false
  let ownerResponse
  let resumedGoalDeadline
  let goalCompletionItemId
  const releaseBusy = () => {
    if (!busyResponse) return
    const { response, id } = busyResponse
    busyResponse = undefined
    response.end(
      createSse([assistantMessage(`${MARKER}_workflow_BUSY_FINISHED`), responseCompleted(id)])
    )
  }
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
  const failedAt = new Date(Date.now() - 60000).toISOString()
  const failedChecks = {
    id: 'preexisting-checks-failure',
    objectId: PREEXISTING_CHECKS_TOPIC,
    version: PREEXISTING_CHECKS_HEAD,
    eventType: 'git.event',
    topicId: PREEXISTING_CHECKS_TOPIC,
    text: `${MARKER}_preexisting_checks_EVENT_RECEIVED`,
    at: failedAt,
    external: {
      eventType: 'tracked.status',
      payload: {
        headRefOid: PREEXISTING_CHECKS_HEAD,
        statusCheckRollup: { state: 'FAILURE' },
        failedAt,
      },
    },
  }
  const saveEvents = async () => {
    // Background MCP readers must see a complete snapshot during event publication.
    const pendingPath = `${recordsPath}.pending`
    await writeFile(
      pendingPath,
      JSON.stringify([
        ...['archive-record', 'long-archive-record'].map(id => ({
          id,
          value: JSON.stringify(events),
        })),
        { id: 'preexisting-checks-record', value: JSON.stringify([failedChecks]) },
      ])
    )
    await rename(pendingPath, recordsPath)
  }
  const event = (
    id,
    text,
    topicId = phase === 'workflow_conflict' ? WORKFLOW_CONFLICT_TOPIC : 'release-document'
  ) => ({
    id,
    eventType: phase === 'workflow_conflict' ? 'git.event' : 'message.received',
    topicId,
    text,
    at: new Date().toISOString(),
    ...(phase === 'workflow'
      ? {
          external: {
            eventType: 'tracked.workflow_run',
            payload: {
              id: 44231414768,
              head_sha: 'a'.repeat(40),
              status: 'completed',
              conclusion: 'failure',
            },
          },
        }
      : phase === 'workflow_conflict'
        ? {
            objectId: WORKFLOW_CONFLICT_TOPIC,
            version: id,
            external: {
              eventType: 'tracked.workflow_run_pr_conflict',
              url: 'https://github.com/org/repo/pull/17',
              payload: { id: 44231414768, head_sha: 'a'.repeat(40), run_attempt: 1 },
            },
          }
        : {}),
  })

  async function verifyResumedGoalControlContext(control) {
    active = true
    phase = 'resumed_goal_seed'
    const taskId = 'resumed-goal-control-context'
    const prompt = `${MARKER}_${phase}`
    const created = await rpc(control, 'runtime.tasks.create', {
      taskId,
      workspacePath,
      runtime: 'codex',
      message: prompt,
      modelSelection: {
        modelName: DEFAULT_MODEL_ID,
        modelType: 'runtime',
        options: { codexProviderId: MODEL_PROVIDER_ID, codexProviderType: 'custom' },
      },
      executionRequest: {
        task_id: taskId,
        subtask_id: `${taskId}-initial`,
        user_id: 9001,
        prompt,
        new_session: true,
        bot: [{ shell_type: 'Codex' }],
        model_config: { model_id: DEFAULT_MODEL_ID, model_provider: MODEL_PROVIDER_ID },
      },
    })
    assert.equal(created.accepted, true, JSON.stringify(created))
    const getTask = () => rpc(control, 'runtime.tasks.get', { taskId })
    const initial = await waitForValue(
      getTask,
      result => result.task?.threadId && !result.task.running && result.task.status === 'done',
      'The initial native conversation must complete before Goal activation',
      modelResponseTimeoutMs
    )
    phase = 'resumed_goal'
    const marker = `${MARKER}_${phase}`
    const getWait = async () =>
      (await getTask()).task.runtimeHandle?.connectionEventSubscriptions?.find(
        item => item.subscription_key === marker
      )
    const setGoal = params => rpc(control, 'runtime.tasks.goal.set', { taskId, ...params })
    const getGoal = () => rpc(control, 'runtime.tasks.goal.get', { taskId })
    const paused = await setGoal({ objective: marker, status: 'paused' })
    assert.equal(paused.goal?.status, 'paused', JSON.stringify(paused))
    const { promise, resolve } = Promise.withResolvers()
    resumedGoalDeadline = promise
    try {
      const resumed = await setGoal({ status: 'active' })
      assert.equal(resumed.goal?.status, 'active', JSON.stringify(resumed))
    } finally {
      resolve()
    }
    await waitForValue(
      getWait,
      wait => wait?.status === 'armed',
      'The resumed native Goal must arm its MCP subscription after the idle deadline',
      modelResponseTimeoutMs
    )
    await waitForValue(
      getGoal,
      result => result.goal?.status === 'blocked',
      'The subscription must suspend the original Goal',
      uiTimeoutMs
    )
    events.push(event('resumed-goal-event', `${marker}_EVENT_RECEIVED`))
    await saveEvents()
    await waitForValue(
      async () => {
        const wait = await getWait()
        if (wait?.status === 'needs_attention') {
          const journal = JSON.parse(
            await readFile(join(executorHome, 'runtime-work/control-operations.json'), 'utf8')
          )
          const { error, result } = journal.operations[wait.operation_id]
          assert.fail(`The event continuation was rejected: ${JSON.stringify(error ?? result)}`)
        }
        const { goal } = await getGoal()
        return { wait, goal }
      },
      ({ wait, goal }) => {
        assert.ok(!wait?.error_code, `Event delivery failed: ${JSON.stringify(wait)}`)
        return completed.has(phase) && goal?.status === 'complete'
      },
      'The event must wake and complete the original Goal',
      30000
    )
    assert.equal((await getTask()).task.threadId, initial.task.threadId)
  }

  return {
    appEnvironment: {
      ...base.appEnvironment,
      ...(controlContextOnly
        ? { WEWORK_E2E_CONTROL_MCP_IDLE_TTL_MS: String(CONTROL_MCP_IDLE_TTL_MS) }
        : {}),
    },
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
      if (phase === 'resumed_goal' && resumedGoalDeadline) {
        const deadline = resumedGoalDeadline
        resumedGoalDeadline = undefined
        await deadline
        // Age the native client's idle credential while real Goal inference is in flight.
        await delay(CONTROL_MCP_IDLE_TTL_MS + 100)
      }
      if (
        phase === 'owner' &&
        !ownerResponse &&
        modelRequestTexts(body).includes(`${MARKER}_owner_CONTINUE`)
      ) {
        ownerResponse = () => {
          const id = `conversation-owner-${++sequence}`
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end(
            createSse([responseCreated(id), ...modelEvents(body, phase), responseCompleted(id)])
          )
        }
        return true
      }
      if (
        phase === 'workflow' &&
        !busyStarted &&
        modelRequestTexts(body).includes(`${MARKER}_workflow_BUSY_HOLD`)
      ) {
        assert.deepEqual(latestWaitingSubscriptions(body), [
          {
            subscription_key: MARKER + '_workflow',
            source: { providerId: PROVIDER, kind: 'record', id: 'archive-record' },
            status: 'armed',
          },
        ])
        busyStarted = true
        const id = `conversation-busy-${++sequence}`
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(createSse([responseCreated(id)]))
        busyResponse = { response, id }
        return true
      }
      if (
        phase === 'workflow' &&
        modelRequestTexts(body).includes(MARKER + '_workflow_EVENT_RECEIVED')
      ) {
        assert.deepEqual(latestWaitingSubscriptions(body), [], 'Delivery must clear the last wait')
      }
      const held = phase === 'human' ? human.intercept(modelRequestTexts(body), response) : null
      if (held) return held
      const id = `conversation-event-${++sequence}`
      const modelOutput =
        phase === 'resumed_goal_seed'
          ? [assistantMessage('Ready to resume a Goal.')]
          : modelEvents(body, phase)
      const goalCompletion =
        phase === 'goal' &&
        modelOutput.find(({ item }) =>
          item?.content?.some(part => part.text?.includes(`${MARKER}_goal_DONE`))
        )
      if (goalCompletion) {
        goalCompletionItemId = goalCompletion.item.id
        const progress = assistantMessage('正在处理收到的文档事件。')
        progress.item.phase = 'commentary'
        modelOutput.unshift(progress)
        // Simulate model latency so this resumed turn has whole seconds to display.
        await delay(1200)
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(createSse([responseCreated(id), ...modelOutput, responseCompleted(id)]))
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
      if (controlContextOnly) return verifyResumedGoalControlContext(control)
      await createSingleRootLocalProject(control, workspacePath, 'conversation-events')
      await selectE2EModel(control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
      active = true
      let originalAddress
      try {
        phase = 'preexisting_checks'
        const marker = `${MARKER}_${phase}`
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
          value: `${marker} 订阅这次提交的 PR 检查结果。`,
        })
        await control.command('waitFor', ACTIVE_SEND_BUTTON_SELECTOR, { enabled: true })
        await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
        const assistant = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`
        await control.command('waitFor', assistant, {
          text: `${marker}_WAITING`,
          timeoutMs: modelResponseTimeoutMs,
        })
        const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
        originalAddress = snapshot.workbench.currentRuntimeTask
        assert.ok(originalAddress?.taskId)
        const getTask = () => rpc(control, 'runtime.tasks.get', { address: originalAddress })
        const initialThread = (await getTask()).task.threadId
        assert.ok(initialThread)
        await control.command('waitFor', assistant, {
          text: `${marker}_DONE`,
          timeoutMs: 30000,
        })
        assert.equal((await getTask()).task.threadId, initialThread)
        const delivery = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="connection-event-message"]`
        await control.command('waitFor', delivery, { text: 'PR 检查结果', timeoutMs: uiTimeoutMs })
        assert.ok(completed.has(phase))

        for (const story of [
          'ordinary',
          'workflow',
          'workflow_conflict',
          'goal',
          'human',
          'cancel',
          'owner',
          'pause',
        ]) {
          phase = story
          await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
            value: `${MARKER}_${phase} ${['ordinary', 'workflow', 'workflow_conflict'].includes(phase) ? '' : '请创建持续目标，'}请订阅文档变化并在变化后继续。`,
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
          if (phase === 'workflow' || phase === 'workflow_conflict') {
            const toggle = '[data-testid="connection-event-condition-toggle"]'
            await control.command('waitFor', toggle, { visible: true, enabled: true })
            await control.command('click', toggle)
            await control.command('waitFor', '[data-testid="connection-event-condition"]', {
              text: phase === 'workflow' ? '或' : '合并冲突',
              visible: true,
            })
          }
          const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
          const address = debug.workbench.currentRuntimeTask
          assert.ok(address?.taskId)
          if (!originalAddress) originalAddress = address
          assert.equal(address.taskId, originalAddress.taskId)
          assert.equal(address.workspacePath, originalAddress.workspacePath)
          if (phase === 'workflow') {
            await control.command(
              'waitFor',
              `[data-testid="runtime-local-task-event-${address.taskId}"][data-state="waiting"]`,
              { visible: true, timeoutMs: uiTimeoutMs }
            )
          }
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
          if (phase === 'workflow' || phase === 'workflow_conflict') {
            const waits = before.task.runtimeHandle?.connectionEventSubscriptions ?? []
            assert.equal(
              waits.filter(wait => ['preparing', 'armed', 'pending'].includes(wait.status)).length,
              1,
              'Alternative Git outcomes use one active wait in the original task'
            )
          }
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
          if (phase === 'owner') {
            await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
              value: `${MARKER}_owner_CONTINUE`,
            })
            await control.command('waitFor', ACTIVE_SEND_BUTTON_SELECTOR, {
              enabled: true,
              timeoutMs: uiTimeoutMs,
            })
            await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
            try {
              await waitForValue(
                () => rpc(control, 'runtime.tasks.goal.get', { address }),
                result => ownerResponse && result.goal?.status === 'active',
                'A user follow-up must reactivate the original event-blocked Goal',
                modelResponseTimeoutMs
              )
            } finally {
              ownerResponse?.()
            }
            await control.command(
              'waitFor',
              `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
              { text: `${MARKER}_owner_DONE`, timeoutMs: modelResponseTimeoutMs }
            )
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
          if (phase === 'workflow_conflict') {
            const stale = event('workflow-conflict-stale', 'Conflict on a stale head')
            stale.external.payload.head_sha = 'b'.repeat(40)
            events.push(stale)
          }
          if (phase === 'workflow') {
            for (const patch of [
              { id: 9 },
              { head_sha: 'b'.repeat(40) },
              { status: 'in_progress' },
              { conclusion: 'cancelled' },
            ]) {
              const ignored = event(
                `workflow-ignored-${JSON.stringify(patch)}`,
                'Nonmatching workflow state'
              )
              Object.assign(ignored.external.payload, patch)
              events.push(ignored)
            }
          }
          await saveEvents()
          if (phase === 'workflow' || phase === 'workflow_conflict') {
            const savedAt = Date.now()
            await waitForValue(
              getTask,
              result =>
                result.task.runtimeHandle?.connectionEventSubscriptions?.some(
                  item =>
                    item.subscription_key === `${MARKER}_${phase}` &&
                    !item.error_code &&
                    item.last_collected_at >= savedAt
                ),
              'The host must collect this saved workflow batch before the negative observation',
              30000
            )
          }
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
          let busyTurnId
          if (phase === 'workflow') {
            await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
              value: `${MARKER}_workflow_BUSY_HOLD`,
            })
            await control.command('waitFor', ACTIVE_SEND_BUTTON_SELECTOR, { enabled: true })
            await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })
            busyTurnId = await waitForValue(
              getTask,
              result => busyStarted && result.task.running && result.task.executionState?.turnId,
              'A real model turn must remain active while the event is delivered',
              modelResponseTimeoutMs
            )
          }
          const match = event(`${phase}-event`, `${MARKER}_${phase}_EVENT_RECEIVED`)
          events.push(match, match)
          await saveEvents()
          if (phase === 'workflow') {
            await waitForValue(
              getTask,
              result =>
                result.task.runtimeHandle?.connectionEventSubscriptions?.some(
                  item =>
                    item.subscription_key === `${MARKER}_workflow` &&
                    item.status === 'delivered' &&
                    item.operation_id
                ),
              'The running turn must accept the matching event',
              30000
            )
            releaseBusy()
          }
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
          if (phase === 'goal') {
            assert.ok(goalCompletionItemId, 'The woken Goal must have a distinct native result')
            const duration = `${assistant}:has([data-runtime-item-id="${goalCompletionItemId}"]) [data-testid="final-processing-toggle"] [data-testid="processing-duration-label"]`
            await control.command('waitFor', duration, { timeoutMs: uiTimeoutMs })
            assert.match(
              await control.command('getText', duration),
              /^(?:用时|Worked for)\s*[1-9]\d*/,
              'The completed event-woken turn must show nonzero processing time'
            )
          }
          const after = await getTask()
          assert.equal(
            after.task.threadId,
            before.task.threadId,
            'The event must resume the original native thread'
          )
          if (busyTurnId) {
            assert.equal(
              after.task.executionState.turnId ?? after.task.executionState.latestTurnId,
              busyTurnId,
              'Native guidance must deliver the event within the running turn'
            )
          }
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
        releaseBusy()
        await human.cleanup(control)
      }
    },
    cleanup() {
      releaseBusy()
      human.release()
    },
    diagnostics() {
      return { phase, modelRequests, questionOutput }
    },
  }
}
