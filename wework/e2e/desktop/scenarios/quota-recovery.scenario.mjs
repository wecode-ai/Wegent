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
  let restartDesktopApp
  const model = createCloudConfigModelService({
    readUsage: () => {
      if (holdQuota && Date.now() >= resetAt * 1000) {
        resetAt = Math.floor(Date.now() / 1000) + 5
      }
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
      const create = async (taskId, delaySeconds, holdUntilRestored = false) => {
        const marker = `WEWORK_QUOTA_${taskId}`
        const plan = model.plan(marker, [
          {
            usageLimit: () => {
              holdQuota = holdUntilRestored
              resetAt = Math.floor(Date.now() / 1000) + delaySeconds
              return resetAt
            },
          },
          { text: `${marker}_RESUMED` },
        ])
        const created = await rpc('runtime.tasks.create', {
          taskId,
          commandId: `${taskId}-command`,
          title: marker,
          runtime: 'codex',
          workspacePath,
          message: marker,
          clientUserMessageId: `${taskId}-user`,
          modelSelection: {
            modelName: MODEL,
            modelType: 'runtime',
            options: { runnerModelProvider: 'openai' },
          },
          executionRequest: {
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
          },
        })
        assert.equal(created.accepted, true)
        const waiting = await waitForValue(
          () => task(taskId),
          value => value?.runtimeHandle?.quotaWait,
          'The subscription error did not enter durable quota waiting',
          RECOVERY_TIMEOUT_MS
        )
        assert.equal(waiting.resumeAt, resetAt * 1000)
        assert.equal(plan.count, 1, 'The limited request was retried before reset')
        return { created, plan }
      }

      const taskId = 'quota-restart'
      const { created, plan } = await create(taskId, 30, true)
      const beforeRestart = await task(taskId)
      assert.equal(beforeRestart.status, 'queued')
      assert.equal(beforeRestart.running, false, 'Quota waiting occupied a native runner')
      await control.command('waitFor', `[data-testid="runtime-local-task-row-${taskId}"]`)
      await control.command('click', `[data-testid="runtime-local-task-row-${taskId}"]`)
      await control.command('waitFor', '[data-testid="runtime-quota-wait-status"]')
      await restartDesktopApp()
      const restored = await waitForValue(
        () => task(taskId),
        value => value?.runtimeHandle?.quotaWait && value,
        'The durable quota wait was not restored after desktop restart',
        RECOVERY_TIMEOUT_MS
      )
      assert.equal(restored.status, 'queued')
      assert.equal(restored.running, false)
      assert.equal(restored.threadId, beforeRestart.threadId)
      assert.equal(plan.count, 1, 'Recovery ran before the restored wait was observed')
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
          return Date.now()
        },
        now => now >= observationDeadline,
        'The cancellation observation window did not finish',
        15_000
      )
      assert.equal((await task('quota-cancel')).runtimeHandle?.quotaWait, undefined)
    },
  }
}
