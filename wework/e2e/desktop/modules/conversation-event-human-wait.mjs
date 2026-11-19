import assert from 'node:assert/strict'
import {
  assistantMessage,
  createSse,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'
import { ACTIVE_WORKBENCH_SELECTOR } from './shared.mjs'

export const EVENT_HUMAN_ANSWER = 'CONTINUE_AFTER_REAL_EVENT_QUESTION'
const BLOCKER = 'WEWORK_CONVERSATION_EVENT_CAPACITY_BLOCKER'

/** Only model responses are held; native questions, source collection and scheduling remain real. */
export function createEventHumanWait({ rpc, workspacePath, uiTimeoutMs, captureScreenshot }) {
  const releases = new Map()
  let originalSettings
  let eventRequests = 0
  const blockerTask = 'event-human-capacity-blocker'
  const waitHeld = key =>
    waitForValue(
      async () => releases.has(key),
      Boolean,
      `Missing held model request ${key}`,
      uiTimeoutMs
    )
  const hold = (key, response) => {
    assert.equal(releases.has(key), false, `Duplicate ${key} model request`)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(createSse([responseCreated(key)]))
    response.flushHeaders()
    let settled = false
    return new Promise(resolve =>
      releases.set(key, () => {
        if (settled) return
        settled = true
        if (!response.destroyed)
          response.end(createSse([assistantMessage(`${key}_DONE`), responseCompleted(key)]))
        resolve(true)
      })
    )
  }
  return {
    intercept(text, response) {
      if (text.includes(BLOCKER)) return hold('event-capacity-blocker', response)
      if (
        text.includes(EVENT_HUMAN_ANSWER) &&
        !text.includes('WEWORK_CONVERSATION_EVENT_human_EVENT_RECEIVED')
      )
        return hold('event-human-answer', response)
      return null
    },
    eventStarted() {
      eventRequests++
    },
    release() {
      for (const release of releases.values()) release()
    },
    async prepare(control, getTask) {
      await waitForValue(
        getTask,
        value => value.task.interactionStatus === 'awaitingUserReply',
        'The native question must remain pending',
        uiTimeoutMs
      )
      originalSettings = await rpc(control, 'runtime.settings.get', {})
      await rpc(control, 'runtime.settings.update', { maxConcurrentTasks: 2 })
      const catalog = await rpc(control, 'runtime.runner.catalog', {})
      const model = catalog.models.find(value => value.runtime === 'codex' && value.is_default)
      assert.ok(model)
      const result = await rpc(control, 'runtime.tasks.create', {
        taskId: blockerTask,
        workspacePath,
        runtime: 'codex',
        message: BLOCKER,
        executionRequest: {
          task_id: blockerTask,
          subtask_id: `${blockerTask}-initial`,
          user_id: 9001,
          prompt: BLOCKER,
          new_session: true,
          bot: [{ shell_type: 'Codex' }],
          model_config: {
            model_id: model.local_model_id,
            model_provider: model.provider,
            runtime_config: { codex: { use_user_config: true, configured: true } },
          },
        },
      })
      assert.equal(result.accepted, true)
      await waitHeld('event-capacity-blocker')
    },
    async verifyPending(control, address, getTask, requestsBefore, readRequestCount) {
      const subscription = task =>
        task.runtimeHandle?.connectionEventSubscriptions?.find(item =>
          item.subscription_key.endsWith('_human')
        )
      const turnId = task => task.executionState?.turnId ?? task.executionState?.latestTurnId
      await waitForValue(
        getTask,
        value =>
          value.task.interactionStatus === 'awaitingUserReply' &&
          subscription(value.task)?.status === 'pending',
        'The event must wait behind the real unanswered question',
        30000
      )
      assert.equal(
        readRequestCount(),
        requestsBefore,
        'A captured event must not start a model while human input is pending'
      )
      const status = '[data-testid="connection-event-status"]'
      const goal = '[data-testid="goal-status-bar"]'
      const card = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="request-user-input-card"]`
      await control.command('waitFor', status, { text: '等待你处理当前问题或确认' })
      await control.command('waitFor', goal, { text: '等待继续执行' })
      assert.equal(
        Number(await control.command('getElementCount', '[data-testid="resume-goal-button"]')),
        0
      )
      await control.command('hover', goal)
      await captureScreenshot(control, 'conversation-event-human-pending.png')
      const previousSize = JSON.parse(
        await control.command('setMainWindowSize', 'body', {
          value: JSON.stringify({ width: 1000, height: 760 }),
        })
      )
      try {
        await control.command('navigate', 'body', { value: '/settings/appearance' })
        await control.command('clickWhenEnabled', '[data-testid="appearance-mode-dark"]')
        await control.command('waitFor', 'html[data-theme="dark"]')
        await control.command('navigate', 'body', { value: '/' })
        await control.command(
          'clickWhenEnabled',
          `[data-testid="runtime-local-task-row-${address.taskId}"]`
        )
        await control.command('waitFor', status, { text: '等待你处理当前问题或确认' })
        await control.command('waitFor', card)
        for (const selector of [status, card]) {
          const metrics = JSON.parse(await control.command('getElementMetrics', selector))
          assert.ok(metrics.length > 0)
          for (const item of metrics)
            assert.ok(
              item.scrollWidth <= item.clientWidth + 1,
              `${selector} must fit the narrow window`
            )
        }
        const title = await control.command('getAttribute', `${status} span[title]`, {
          value: 'title',
        })
        assert.ok(title.length > 80, 'The long source name must remain available in full')
        await captureScreenshot(control, 'conversation-event-human-narrow-dark.png')
      } finally {
        await control.command('navigate', 'body', { value: '/settings/appearance' })
        await control.command('clickWhenEnabled', '[data-testid="appearance-mode-light"]')
        await control.command('waitFor', 'html[data-theme="light"]')
        await control.command('setMainWindowSize', 'body', { value: JSON.stringify(previousSize) })
        await control.command('navigate', 'body', { value: '/' })
        await control.command(
          'clickWhenEnabled',
          `[data-testid="runtime-local-task-row-${address.taskId}"]`
        )
      }
      const questionTurnId = turnId((await getTask()).task)
      await control.command(
        'fill',
        `${card} [data-testid="request-user-input-custom-question_1"]`,
        { value: EVENT_HUMAN_ANSWER }
      )
      await control.command(
        'clickWhenEnabled',
        `${card} [data-testid="request-user-input-submit-button"]`
      )
      const answer = await waitForValue(
        getTask,
        ({ task }) =>
          turnId(task) &&
          turnId(task) !== questionTurnId &&
          (releases.has('event-human-answer') || eventRequests > 0),
        'The answer must open a native turn and reach the model',
        uiTimeoutMs
      )
      const answerTurnId = turnId(answer.task)
      await rpc(control, 'runtime.settings.update', { maxConcurrentTasks: 1 })
      releases.get('event-human-answer')?.()
      // A matching event can steer the answer turn before the capacity change.
      const delivery = await waitForValue(
        getTask,
        ({ task }) =>
          !task.interactionStatus &&
          Boolean(subscription(task)?.operation_id) &&
          ((subscription(task)?.status === 'delivered' && eventRequests > 0) ||
            (subscription(task)?.status === 'resuming_goal' &&
              !task.running &&
              task.goalStatus === 'blocked')),
        'The event must reach the answer turn or queue behind the occupied worker slot',
        30000
      )
      if (subscription(delivery.task)?.status === 'delivered') {
        assert.equal(turnId(delivery.task), answerTurnId, 'The event must steer the answer turn')
        assert.equal(eventRequests, 1, 'The event must enter the model once')
        releases.get('event-capacity-blocker')()
        return
      }
      assert.equal(
        eventRequests,
        0,
        'Queued event work must not reach the model before capacity is released'
      )
      await control.command('waitFor', goal, { text: '等待继续执行' })
      await control.command('waitFor', status, { text: '已收到事件，等待会话继续执行' })
      assert.equal(
        Number(await control.command('getElementCount', '[data-testid="resume-goal-button"]')),
        0
      )
      await control.command('hover', goal)
      await captureScreenshot(control, 'conversation-event-worker-queued.png')
      releases.get('event-capacity-blocker')()
    },
    async cleanup(control) {
      for (const release of releases.values()) release()
      if (originalSettings) {
        await rpc(control, 'runtime.settings.update', originalSettings)
        originalSettings = undefined
      }
    },
  }
}
