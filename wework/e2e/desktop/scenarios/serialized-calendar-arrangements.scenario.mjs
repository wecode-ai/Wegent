import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopScenario as createExistingScenario } from './coordination-arrangements.scenario.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'
import {
  assistantMessage,
  createSse,
  isReplyPredictionRequest,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const USER = 9001
const MARKER = 'CALENDAR_SERIAL_QUEUE_WORK'
const AUTOMATION = 'calendar-serialized-deadlines'
const PERSONAL_AUTOMATION = 'personal-schedule-after-restart'
const WORKSPACE_PROJECT = 'arrangement-recovery-workspace'

/** Reuse the existing recovery checkpoint and hold only its model service. */
export function createDesktopScenario(options) {
  const existing = createExistingScenario(options)
  let calls = 0
  let releaseFirst
  let failureDiagnostics
  return {
    ...existing,
    diagnostics() {
      return { calls, failureDiagnostics }
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (await existing.handleHttp(request, response, url)) return true
      if (isReplyPredictionRequest(body) || !JSON.stringify(body.input ?? []).includes(MARKER))
        return false
      calls++
      const id = `serialized-calendar-${calls}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      const finish = () =>
        response.end(
          createSse([
            responseCreated(id),
            assistantMessage('本轮安排已完成'),
            responseCompleted(id),
          ])
        )
      if (calls === 1) releaseFirst = finish
      else finish()
      return true
    },
    async verify(control) {
      await existing.verify(control)
      const rpc = (method, params = {}) =>
        requestExecutor(control, method, params, options.uiTimeoutMs)
      const initial = await rpc('runtime.stand_in.personal.get', { userId: USER })
      const catalog = await rpc('runtime.runner.catalog')
      const model = catalog.models.find(row => row.runtime === 'codex' && row.is_default)
      assert.ok(model)
      const runs = []
      const interruptedRunId = randomUUID()
      try {
        await rpc('runtime.stand_in.personal.save', {
          userId: USER,
          settings: {
            ...initial,
            primary: {
              ...initial.primary,
              enabled: true,
              prompt: '',
              preferences: '',
              model,
              workspace: {
                projectKey: 'arrangement-recovery-workspace',
                workspacePath: options.workspacePath,
                executionMode: 'current_workspace',
              },
              calendar: {
                policy: {
                  automatic: true,
                  askBeforeAct: true,
                  immediate: true,
                },
              },
            },
          },
        })
        await rpc('runtime.automations.create', {
          automation: {
            id: AUTOMATION,
            version: 0,
            name: '同一安排逐轮执行',
            prompt: MARKER,
            enabled: true,
            timezone: 'UTC',
            schedule: { type: 'interval', value: 1, unit: 'hours' },
            conversationMode: 'independent',
            taskRequest: {
              standInOwner: { userId: USER, roleId: '@primary' },
              standInCalendar: {},
            },
            taskPayload: { runtime: 'codex', title: '同一安排逐轮执行' },
          },
        })
        await rpc('runtime.automations.create', {
          automation: {
            id: PERSONAL_AUTOMATION,
            version: 0,
            name: '恢复项目定时任务',
            prompt: 'Review the linked project',
            enabled: true,
            timezone: 'UTC',
            schedule: { type: 'one_time', execute_at: '2099-01-01T00:00:00Z' },
            taskRequest: {
              deviceId: 'local-device',
              runtime: 'codex',
              message: 'Review the linked project',
              runtimeProjectKey: WORKSPACE_PROJECT,
            },
            taskPayload: { runtime: 'codex', title: '恢复项目定时任务' },
          },
        })
        await options.restartDesktopApp({
          afterStop: async () => {
            const path = join(options.executorHome, 'runtime-work', 'automations.json')
            const state = JSON.parse(await readFile(path, 'utf8'))
            for (const offset of [2000, 1000]) {
              const id = randomUUID()
              const at = new Date(Date.now() - offset).toISOString()
              const run = {
                id,
                automationId: AUTOMATION,
                scheduledFor: at,
                trigger: 'scheduled',
                status: 'pending',
                taskId: null,
                error: null,
                createdAt: at,
                updatedAt: at,
                coordination: {
                  userId: USER,
                  roleId: '@primary',
                  automationVersion: state.automations[AUTOMATION].version,
                  taskId: `stand-in-arrangement-${USER}-${id}`,
                },
              }
              state.runs.push(run)
              runs.push(run)
            }
            const interruptedAt = new Date(Date.now() - 60_000).toISOString()
            state.runs.push({
              id: interruptedRunId,
              automationId: PERSONAL_AUTOMATION,
              scheduledFor: interruptedAt,
              trigger: 'scheduled',
              status: 'running',
              taskId: 'interrupted-unowned-task',
              createdAt: interruptedAt,
              updatedAt: interruptedAt,
            })
            await writeFile(path, JSON.stringify(state))
          },
        })
        await until(
          () => rpc('runtime.automation_runs.list'),
          result =>
            calls === 1 &&
            result.items.some(run => run.id === runs[0].id && run.status === 'running'),
          'The first real calendar execution did not reach its model',
          options.modelResponseTimeoutMs + options.uiTimeoutMs
        )
        // A second snapshot while the first model is held must retain the next deadline.
        const contexts = await rpc('runtime.coordination.contexts', {})
        const context = contexts.contexts.find(row => row.id === `personal:${USER}`)
        assert.ok(context)
        await rpc('runtime.coordination.snapshot', {
          contextId: context.id,
          revision: context.revision,
        })
        const blocked = await rpc('runtime.automation_runs.list', {})
        assert.equal(blocked.items.find(run => run.id === runs[1].id).status, 'pending')
        assert.equal(calls, 1, 'The same arrangement must not execute overlapping model turns')
        releaseFirst()
        releaseFirst = null
        await until(
          () => rpc('runtime.automation_runs.list'),
          result =>
            runs.every(expected =>
              result.items.some(run => run.id === expected.id && run.status === 'succeeded')
            ),
          'Both preserved deadlines must finish in order after the first execution releases',
          options.modelResponseTimeoutMs + options.uiTimeoutMs
        )
        assert.equal(calls, 2, 'Each deadline must execute exactly once')

        const scheduledItem = `[data-testid="automation-open-${PERSONAL_AUTOMATION}"]`
        const projectPicker = '[data-testid="automation-project-select"]'
        const saveButton = '[data-testid="automation-save-button"]'
        await control.command('clickWhenEnabled', '[data-testid="automation-button"]')
        await control.command('clickWhenEnabled', scheduledItem)
        const interruptedStatus = `[data-testid="automation-run-status-${interruptedRunId}"]`
        await control.command('waitFor', interruptedStatus, { text: '需要关注' })
        await control.command('scrollIntoView', interruptedStatus)
        await options.captureScreenshot(control, 'automation-interrupted-run.png')
        await control.command('waitFor', projectPicker, { text: 'Arrangement workspace' })
        await control.command('fill', '[data-testid="automation-prompt-input"]', {
          value: 'Review the linked project after restart',
        })
        await control.command('clickWhenEnabled', saveButton)
        await control.command('waitFor', saveButton, { visible: false })
        await control.command('waitFor', projectPicker, { text: 'Arrangement workspace' })
        await control.command('click', '[data-testid="automation-detail-close"]')
        await control.command('clickWhenEnabled', scheduledItem)
        await control.command('waitFor', projectPicker, { text: 'Arrangement workspace' })
        await control.command('scrollIntoView', projectPicker)
        await options.captureScreenshot(control, 'automation-reopened-project.png')
        const saved = await rpc('runtime.automations.get', { automationId: PERSONAL_AUTOMATION })
        assert.equal(saved.automation.taskRequest.runtimeProjectKey, WORKSPACE_PROJECT)
      } catch (error) {
        failureDiagnostics = {
          runs: await rpc('runtime.automation_runs.list'),
          processing: await rpc('runtime.stand_in.processing.status', { userId: USER }),
        }
        throw error
      } finally {
        releaseFirst?.()
        await rpc('runtime.automations.delete', { automationId: AUTOMATION })
        await rpc('runtime.automations.delete', { automationId: PERSONAL_AUTOMATION })
        const latest = await rpc('runtime.stand_in.personal.get', { userId: USER })
        await rpc('runtime.stand_in.personal.save', {
          userId: USER,
          settings: { ...initial, version: latest.version },
        })
      }
    },
  }
}
