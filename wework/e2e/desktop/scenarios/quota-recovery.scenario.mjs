import assert from 'node:assert/strict'
import { createCloudConfigModelService } from '../modules/cloud-config-model-service.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { createSingleRootLocalProject, DEFAULT_STEP_TIMEOUT_MS } from '../modules/shared.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'

const MODEL = 'gpt-6.1-sol'
const RECOVERY_TIMEOUT_MS = 60_000

export function createDesktopScenario({ workspacePath }) {
  let resetAt = 0
  let holdQuota = false
  let usageHold
  let restartDesktopApp
  const model = createCloudConfigModelService({
    readUsage: async () => {
      const held = usageHold
      if (held) {
        held.requests += 1
        await held.wait
      }
      if (holdQuota && Date.now() >= resetAt * 1000) {
        resetAt = Math.floor(Date.now() / 1000) + 5
      }
      console.info('[desktop-e2e] quota usage snapshot', { at: Date.now(), resetAt, holdQuota })
      return {
        plan_type: 'enterprise',
        rate_limit: {
          allowed: Date.now() >= resetAt * 1000,
          limit_reached: Date.now() < resetAt * 1000,
          primary_window: {
            used_percent: Date.now() < resetAt * 1000 ? 100 : 0,
            reset_at: resetAt,
            reset_after_seconds: Math.max(0, resetAt - Math.floor(Date.now() / 1000)),
            limit_window_seconds: 18_000,
          },
          secondary_window: null,
        },
      }
    },
  })
  return {
    prepareApp: model.prepareApp,
    attachServer: model.attachServer,
    handleHttp: model.handleHttp,
    close: model.close,
    diagnostics: model.diagnostics,
    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
    },
    async verify(control) {
      await createSingleRootLocalProject(control, workspacePath, 'quota-recovery')
      const rpc = (method, params) =>
        requestExecutor(control, method, params, DEFAULT_STEP_TIMEOUT_MS)
      const task = async taskId => (await rpc('runtime.tasks.get', { taskId })).task
      // Startup can recheck an expired wait before returning the task to the queue.
      const waitForRestoredQuota = taskId =>
        waitForValue(
          () => task(taskId),
          value =>
            value?.runtimeHandle?.quotaWait && value.status === 'queued' && value.running === false,
          `The durable quota wait for ${taskId} was not restored after desktop restart`,
          RECOVERY_TIMEOUT_MS
        )
      const create = async (
        taskId,
        delaySeconds,
        holdUntilRestored = false,
        { goal = false, responses } = {}
      ) => {
        const marker = `WEWORK_QUOTA_${taskId}`
        let expectedResetAt = 0
        const plan = model.plan(marker, [
          {
            usageLimit: () => {
              holdQuota = holdUntilRestored
              resetAt = Math.floor(Date.now() / 1000) + delaySeconds
              expectedResetAt = resetAt
              console.info('[desktop-e2e] initial quota limit', {
                taskId,
                at: Date.now(),
                expectedResetAt,
              })
              return resetAt
            },
          },
          ...(responses ?? [{ text: `${marker}_RESUMED` }]),
        ])
        const executionRequest = {
          task_id: taskId,
          subtask_id: `${taskId}-initial`,
          user_id: 9001,
          prompt: marker,
          new_session: true,
          project_workspace_path: workspacePath,
          bot: [{ shell_type: 'Codex', name: 'Quota recovery' }],
          model_config: {
            model_id: MODEL,
            model_provider: 'openai',
            wework_model_kind: 'codex-official',
          },
        }
        const created = await rpc('runtime.tasks.create', {
          taskId,
          commandId: `${taskId}-command`,
          title: marker,
          runtime: 'codex',
          workspacePath,
          message: marker,
          clientUserMessageId: `${taskId}-user`,
          ...(goal ? { initialGoal: { objective: marker, status: 'active' } } : {}),
          modelSelection: {
            modelName: MODEL,
            modelType: 'runtime',
            options: { runnerModelProvider: 'openai' },
          },
          executionRequest,
        })
        assert.equal(created.accepted, true)
        const waiting = await waitForValue(
          () => task(taskId),
          value =>
            value?.status === 'queued' && value.running === false && value.runtimeHandle?.quotaWait,
          'The subscription error did not enter durable quota waiting',
          RECOVERY_TIMEOUT_MS
        )
        assert.equal(
          waiting.resumeAt,
          expectedResetAt * 1000,
          `The first queued quota deadline for ${taskId} differs from its initial limit response`
        )
        assert.equal(plan.count, 1, 'The limited request was retried before reset')
        return {
          created,
          plan,
          taskId,
          marker,
          executionRequest,
          resumeAt: waiting.resumeAt,
          address: { deviceId: created.deviceId, taskId },
        }
      }

      const taskId = 'quota-restart'
      const { created, plan } = await create(taskId, 30, true)
      const beforeRestart = await task(taskId)
      assert.equal(beforeRestart.status, 'queued')
      assert.equal(beforeRestart.running, false, 'Quota waiting occupied a native runner')
      const continuingGoal = await create('quota-goal-continue', 30, true, {
        goal: true,
        responses: [
          { hold: true, text: 'WEWORK_QUOTA_GOAL_RESUMED' },
          { hold: true, tool: { name: 'update_goal', arguments: { status: 'complete' } } },
          { text: 'WEWORK_QUOTA_GOAL_COMPLETE' },
        ],
      })
      const originalGoal = (
        await rpc('runtime.tasks.goal.get', { address: continuingGoal.address })
      ).goal
      assert.equal(originalGoal.objective, continuingGoal.marker)
      assert.ok(['blocked', 'usageLimited'].includes(originalGoal.status))
      const goalThreadId = (await task(continuingGoal.taskId)).threadId
      const stoppedGoals = []
      for (const action of ['paused', 'clear']) {
        const fixture = await create(`quota-goal-${action}`, 30, true, { goal: true })
        const result = await rpc(
          action === 'clear' ? 'runtime.tasks.goal.clear' : 'runtime.tasks.goal.set',
          { address: fixture.address, ...(action === 'paused' ? { status: 'paused' } : {}) }
        )
        assert.equal(result.accepted, true, result.error)
        if (action === 'clear') assert.equal(result.cleared, true)
        else assert.equal(result.goal.status, 'paused')
        await waitForValue(
          () => task(fixture.taskId),
          value => !value?.runtimeHandle?.quotaWait,
          `The ${action} Goal retained its durable quota wait`,
          DEFAULT_STEP_TIMEOUT_MS
        )
        stoppedGoals.push({ ...fixture, action })
      }
      const originalResetAt = resetAt
      const stoppedPreparation = await create('quota-preparation-cancel', 5, true)
      let releaseUsage
      usageHold = {
        requests: 0,
        wait: new Promise(resolve => {
          releaseUsage = resolve
        }),
      }
      let preparation
      try {
        preparation = await waitForValue(
          () => task(stoppedPreparation.taskId),
          value =>
            value?.running &&
            value.executionState?.phase === 'starting' &&
            !value.runtimeHandle?.quotaWait &&
            usageHold.requests > 0,
          'The real quota preparation did not reach its held usage preflight',
          RECOVERY_TIMEOUT_MS
        )
        assert.equal(stoppedPreparation.plan.count, 1)
        assert.ok(Date.now() >= stoppedPreparation.resumeAt)
        console.info('[desktop-e2e] quota preparation usage preflight held', {
          taskId: stoppedPreparation.taskId,
          threadId: preparation.threadId,
          phase: preparation.executionState.phase,
          heldUsageRequests: usageHold.requests,
          modelRequests: stoppedPreparation.plan.count,
        })
        const acknowledgement = await requestExecutor(
          control,
          'runtime.tasks.cancel',
          { taskId: stoppedPreparation.taskId },
          2_000
        )
        assert.equal(acknowledgement.accepted, true)
        await waitForValue(
          () => task(stoppedPreparation.taskId),
          value =>
            value?.status === 'cancelled' && !value.running && !value.runtimeHandle?.quotaWait,
          'The cancelled preparation did not settle before its usage response was released',
          DEFAULT_STEP_TIMEOUT_MS
        )
        assert.equal(stoppedPreparation.plan.count, 1)
      } finally {
        resetAt = originalResetAt
        holdQuota = true
        usageHold = undefined
        releaseUsage()
      }
      await control.command('waitFor', `[data-testid="runtime-local-task-row-${taskId}"]`)
      await control.command('click', `[data-testid="runtime-local-task-row-${taskId}"]`)
      await control.command('waitFor', '[data-testid="runtime-quota-wait-status"]')
      await restartDesktopApp()
      const restored = await waitForRestoredQuota(taskId)
      assert.equal(restored.threadId, beforeRestart.threadId)
      assert.equal(plan.count, 1, 'Recovery ran before the restored wait was observed')
      const restoredGoal = await waitForRestoredQuota(continuingGoal.taskId)
      assert.equal(restoredGoal.threadId, goalThreadId)
      assert.equal(continuingGoal.plan.count, 1)
      const stoppedAfterRestart = await task(stoppedPreparation.taskId)
      assert.equal(stoppedAfterRestart.status, 'cancelled')
      assert.equal(stoppedAfterRestart.running, false)
      assert.equal(stoppedAfterRestart.runtimeHandle?.quotaWait, undefined)
      assert.equal(stoppedAfterRestart.threadId, preparation.threadId)
      assert.equal(
        stoppedPreparation.plan.count,
        1,
        'Restart revived a cancelled quota preparation'
      )
      holdQuota = false
      await waitForValue(
        () => task(taskId),
        value => value?.status === 'done' && plan.count === 2,
        'The quota wait did not resume after a real desktop restart',
        RECOVERY_TIMEOUT_MS
      )
      const resumed = await task(taskId)
      assert.equal(resumed.threadId, beforeRestart.threadId)
      assert.equal(plan.count, 2, 'Quota recovery must issue exactly one continuation request')
      assert.equal(plan.calls[1].body.model, plan.calls[0].body.model)
      assert.ok(plan.calls[1].at >= resetAt * 1000, 'Recovery ran before the usage window reset')
      const transcript = await rpc('runtime.tasks.transcript', {
        address: { deviceId: created.deviceId, taskId },
        refresh: true,
      })
      const userMessages = transcript.messages.filter(message => message.role === 'user')
      assert.equal(userMessages.length, 1, 'Recovery resubmitted the original user message')
      assert.equal(userMessages[0].content, `WEWORK_QUOTA_${taskId}`)
      assert.ok(
        transcript.messages.some(
          message =>
            message.role === 'assistant' && message.content === `WEWORK_QUOTA_${taskId}_RESUMED`
        ),
        'The resumed model reply was not saved in the original conversation'
      )

      await waitForValue(
        () => task(continuingGoal.taskId),
        value => value?.running && continuingGoal.plan.count === 2,
        'The ongoing Goal did not resume after its quota reset',
        RECOVERY_TIMEOUT_MS
      )
      const resumedGoal = (await rpc('runtime.tasks.goal.get', { address: continuingGoal.address }))
        .goal
      assert.equal(resumedGoal.status, 'active')
      assert.ok(
        continuingGoal.plan.calls[1].at >= continuingGoal.resumeAt,
        'Goal recovery ran before the usage window reset'
      )
      for (const key of ['objective', 'createdAt', 'tokenBudget'])
        assert.equal(resumedGoal[key], originalGoal[key], `Quota recovery replaced Goal ${key}`)
      assert.ok(resumedGoal.tokensUsed >= originalGoal.tokensUsed)
      assert.ok(resumedGoal.timeUsedSeconds >= originalGoal.timeUsedSeconds)
      continuingGoal.plan.rounds[1].release()
      await waitForValue(
        () => task(continuingGoal.taskId),
        value => value?.running && continuingGoal.plan.count === 3,
        'The restored Goal stopped after one turn instead of continuing automatically',
        RECOVERY_TIMEOUT_MS
      )
      assert.equal(
        (await rpc('runtime.tasks.goal.get', { address: continuingGoal.address })).goal.status,
        'active'
      )
      continuingGoal.plan.rounds[2].release()
      await waitForValue(
        () => task(continuingGoal.taskId),
        value => value?.status === 'done' && continuingGoal.plan.count === 4,
        'The native Goal did not finish through its real update_goal tool',
        RECOVERY_TIMEOUT_MS
      )
      const completedGoal = (
        await rpc('runtime.tasks.goal.get', { address: continuingGoal.address })
      ).goal
      assert.equal(completedGoal.status, 'complete')
      assert.equal(completedGoal.createdAt, originalGoal.createdAt)
      assert.equal((await task(continuingGoal.taskId)).threadId, goalThreadId)
      for (const call of continuingGoal.plan.calls)
        assert.equal(call.body.model, continuingGoal.plan.calls[0].body.model)
      const goalTranscript = await rpc('runtime.tasks.transcript', {
        address: continuingGoal.address,
        refresh: true,
      })
      const goalUserMessages = goalTranscript.messages.filter(message => message.role === 'user')
      assert.equal(goalUserMessages.length, 1, 'Goal recovery replayed the original user message')
      assert.equal(goalUserMessages[0].content, continuingGoal.marker)
      assert.ok(
        goalTranscript.messages.some(
          message =>
            message.role === 'assistant' && message.content === 'WEWORK_QUOTA_GOAL_COMPLETE'
        ),
        'The completed Goal lost its final reply'
      )

      const successorMarker = 'WEWORK_QUOTA_PREPARATION_SUCCESSOR'
      const successor = model.plan(successorMarker, [{ text: `${successorMarker}_COMPLETE` }])
      const successorSent = await rpc('runtime.tasks.send', {
        taskId: stoppedPreparation.taskId,
        commandId: `${stoppedPreparation.taskId}-successor-command`,
        clientUserMessageId: `${stoppedPreparation.taskId}-successor-user`,
        workspacePath,
        message: successorMarker,
        executionRequest: {
          ...stoppedPreparation.executionRequest,
          subtask_id: `${stoppedPreparation.taskId}-successor`,
          prompt: successorMarker,
          new_session: false,
        },
      })
      assert.equal(successorSent.accepted, true)
      await waitForValue(
        () => task(stoppedPreparation.taskId),
        value => value?.status === 'done' && successor.count === 1,
        'A distinct successor could not finish in the cancelled preparation conversation',
        RECOVERY_TIMEOUT_MS
      )
      const successorTranscript = await rpc('runtime.tasks.transcript', {
        address: stoppedPreparation.address,
        refresh: true,
      })
      for (const content of [stoppedPreparation.marker, successorMarker])
        assert.equal(
          successorTranscript.messages.filter(
            message => message.role === 'user' && message.content === content
          ).length,
          1,
          'The successor replayed or lost a user message'
        )
      assert.equal(
        successorTranscript.messages.filter(
          message =>
            message.role === 'assistant' && message.content === `${successorMarker}_COMPLETE`
        ).length,
        1
      )
      assert.ok(
        !successorTranscript.messages.some(
          message => message.content === `${stoppedPreparation.marker}_RESUMED`
        ),
        'The cancelled preparation produced its obsolete continuation reply'
      )
      assert.equal((await task(stoppedPreparation.taskId)).threadId, preparation.threadId)

      const cancelled = await create('quota-cancel', 10, true)
      await control.command('waitFor', '[data-testid="runtime-local-task-row-quota-cancel"]')
      await control.command('click', '[data-testid="runtime-local-task-row-quota-cancel"]')
      await control.command('waitFor', '[data-testid="cancel-quota-recovery"]')
      await control.command('click', '[data-testid="cancel-quota-recovery"]')
      await waitForValue(
        () => task('quota-cancel'),
        value => !value?.runtimeHandle?.quotaWait,
        'Cancelling automatic recovery did not remove the durable wait',
        DEFAULT_STEP_TIMEOUT_MS
      )
      holdQuota = false
      const observationDeadline = Math.max(resetAt * 1000 + 500, Date.now() + 10_000)
      await waitForValue(
        async () => {
          assert.equal(
            cancelled.plan.count,
            1,
            'A cancelled quota wait started another model request'
          )
          for (const fixture of stoppedGoals)
            assert.equal(fixture.plan.count, 1, `The ${fixture.action} Goal resumed after reset`)
          assert.equal(continuingGoal.plan.count, 4, 'The completed Goal continued again')
          assert.equal(stoppedPreparation.plan.count, 1, 'A stopped preparation resumed late')
          assert.equal(successor.count, 1, 'The successor was repeated by stale recovery')
          return Date.now()
        },
        now => now >= observationDeadline,
        'The cancellation observation window did not finish',
        15_000
      )
      assert.equal((await task('quota-cancel')).runtimeHandle?.quotaWait, undefined)
      const finalSuccessor = await task(stoppedPreparation.taskId)
      assert.equal(finalSuccessor.status, 'done', 'A late cancellation stopped the successor')
      assert.equal(finalSuccessor.runtimeHandle?.quotaWait, undefined)
      for (const fixture of stoppedGoals) {
        assert.equal((await task(fixture.taskId)).runtimeHandle?.quotaWait, undefined)
        const goal = (await rpc('runtime.tasks.goal.get', { address: fixture.address })).goal
        assert.equal(goal?.status ?? null, fixture.action === 'clear' ? null : 'paused')
      }
    },
  }
}
