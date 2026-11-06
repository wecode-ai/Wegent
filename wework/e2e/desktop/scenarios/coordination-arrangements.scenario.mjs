import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  assistantMessage,
  createSse,
  delegatedTaskResultEvents,
  isReplyPredictionRequest,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const USER = 9001
const MARKER = 'ARRANGEMENT_RECOVERY_NATIVE_WORK'

/** Seed durable crash boundaries with all writers stopped; Core, Executor and Codex remain real. */
export function createDesktopScenario({
  captureScreenshot,
  executorHome,
  restartDesktopApp,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  workspacePath,
}) {
  const path = join(executorHome, 'runtime-work', 'automations.json')
  let calls = 0
  const runs = []
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  async function until(load, ready, label) {
    const deadline = Date.now() + modelResponseTimeoutMs + uiTimeoutMs
    let latest
    while (Date.now() < deadline) {
      latest = await load()
      if (ready(latest)) return latest
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.fail(`${label}: ${JSON.stringify(latest)}`)
  }
  async function showArrangements(control) {
    await control.command('navigate', 'body', { value: '/automations' })
    await control.command('waitFor', '[data-testid="create-automation-button"]')
    await control.command('waitFor', '[data-testid="automation-open-arrangement-once"]')
  }
  return {
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      const resultEvents = delegatedTaskResultEvents(body)
      if (resultEvents) {
        const id = `arrangement-result-${Date.now()}`
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.end(createSse([responseCreated(id), ...resultEvents, responseCompleted(id)]))
        return true
      }
      if (isReplyPredictionRequest(body) || !JSON.stringify(body.input ?? []).includes(MARKER))
        return false
      calls++
      const id = `arrangement-model-${calls}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage('已完成安排的工作。'),
          responseCompleted(id),
        ])
      )
      return true
    },
    async verify(control) {
      const initial = await rpc(control, 'runtime.stand_in.personal.get', { userId: USER })
      const catalog = await rpc(control, 'runtime.runner.catalog', {})
      const model = catalog.models.find(model => model.runtime === 'codex' && model.is_default)
      assert.ok(model)
      await control.command('seedLocalProject', 'body', {
        value: JSON.stringify({
          projectKey: 'arrangement-recovery-workspace',
          name: 'Arrangement workspace',
          path: workspacePath,
        }),
      })
      await rpc(control, 'runtime.stand_in.personal.save', {
        userId: USER,
        settings: {
          ...initial,
          primary: {
            enabled: true,
            prompt: '',
            preferences: '',
            model,
            workspace: {
              projectKey: 'arrangement-recovery-workspace',
              workspacePath,
              executionMode: 'current_workspace',
            },
          },
        },
      })
      await ensureExperimentalFeaturesEnabled(control)
      for (const type of ['once', 'recurring']) {
        const id = `arrangement-${type}`
        await rpc(control, 'runtime.automations.create', {
          automation: {
            id,
            version: 0,
            name: type === 'once' ? '恢复一次安排' : '恢复周期安排',
            prompt: `${MARKER}_${type}`,
            enabled: true,
            timezone: 'UTC',
            schedule:
              type === 'once'
                ? { type: 'one_time', execute_at: '2099-01-01T00:00:00Z' }
                : { type: 'interval', value: 1, unit: 'hours' },
            conversationMode: 'independent',
            taskRequest: { standInOwner: { userId: USER, roleId: '@primary' } },
            taskPayload: {
              runtime: 'codex',
              title: type === 'once' ? '恢复一次安排' : '恢复周期安排',
            },
          },
        })
      }
      await showArrangements(control)
      await captureScreenshot(control, 'arrangements-01-inside-personal-stand-in.png')
      await restartDesktopApp({
        afterStop: async () => {
          const state = JSON.parse(await readFile(path, 'utf8'))
          const now = new Date().toISOString()
          for (const type of ['once', 'recurring']) {
            const automation = state.automations[`arrangement-${type}`]
            const id = randomUUID()
            // This is precisely the durable output of AutomationStore.due before handoff.
            const run = {
              id,
              automationId: automation.id,
              scheduledFor: now,
              trigger: 'scheduled',
              status: 'pending',
              taskId: null,
              error: null,
              createdAt: now,
              updatedAt: now,
              coordination: {
                userId: USER,
                roleId: '@primary',
                automationVersion: automation.version,
                taskId: `stand-in-arrangement-${USER}-${id}`,
              },
            }
            state.runs.push(run)
            runs.push(run)
            if (type === 'once') {
              automation.enabled = false
              automation.nextRunAt = null
            }
          }
          await writeFile(path, JSON.stringify(state))
        },
      })
      const completed = await until(
        () => rpc(control, 'runtime.automation_runs.list', {}),
        result =>
          runs.every(run =>
            result.items.some(item => item.id === run.id && item.status === 'succeeded')
          ),
        'Both durable due runs must recover through the real plugin'
      )
      assert.equal(calls, 2)
      for (const run of runs) {
        const item = completed.items.find(item => item.id === run.id)
        assert.equal(item.taskId, run.coordination.taskId)
        const receipt = await rpc(control, 'runtime.tasks.commands.get', {
          taskId: item.taskId,
          commandId: `arrangement-run:${run.id}`,
          userId: USER,
        })
        assert.equal(receipt.state, 'settled')
      }
      await showArrangements(control)
      await control.command('click', '[data-testid="automation-open-arrangement-once"]')
      await control.command('waitFor', '[data-testid^="automation-run-status-"]', {
        text: '已完成',
      })
      await control.command('scrollIntoView', '[data-testid^="automation-run-status-"]')
      await captureScreenshot(control, 'arrangements-02-once-recovered-in-original-history.png')
      await control.command('click', '[data-testid="automation-detail-close"]')
      await control.command('click', '[data-testid="automation-open-arrangement-recurring"]')
      await control.command('waitFor', '[data-testid^="automation-run-status-"]', {
        text: '已完成',
      })
      await control.command('scrollIntoView', '[data-testid^="automation-run-status-"]')
      await captureScreenshot(
        control,
        'arrangements-03-recurring-recovered-in-original-history.png'
      )
      await restartDesktopApp({
        afterStop: async () => {
          const state = JSON.parse(await readFile(path, 'utf8'))
          // Reproduce receipt durable, run update not durable. The encrypted Native journal is untouched.
          for (const run of state.runs.filter(run =>
            runs.some(original => original.id === run.id)
          )) {
            run.status = 'pending'
            run.taskId = null
          }
          await writeFile(path, JSON.stringify(state))
        },
      })
      await until(
        () => rpc(control, 'runtime.automation_runs.list', {}),
        result =>
          runs.every(run =>
            result.items.some(item => item.id === run.id && item.status === 'succeeded')
          ),
        'Original receipts must settle the restored runs without resending'
      )
      assert.equal(calls, 2, 'Recovery must not make a second Native execution for either run')
      const tasks = await rpc(control, 'runtime.tasks.list', {})
      const serialized = JSON.stringify(tasks)
      for (const run of runs) assert.ok(serialized.includes(run.coordination.taskId))
      await showArrangements(control)
      await control.command('click', '[data-testid="automation-open-arrangement-once"]')
      await control.command('waitFor', '[data-testid^="automation-run-status-"]', {
        text: '已完成',
      })
      await control.command('scrollIntoView', '[data-testid^="automation-run-status-"]')
      await captureScreenshot(
        control,
        'arrangements-04-original-receipt-no-duplicate-after-restart.png'
      )
    },
  }
}
