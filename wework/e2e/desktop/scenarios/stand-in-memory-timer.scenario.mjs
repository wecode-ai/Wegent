import assert from 'node:assert/strict'
import { openStandInSettings } from '../modules/stand-in-profile-navigation.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { selectE2EModel } from '../modules/shared.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  createMemoryConsolidation,
  MEMORY_HISTORY_FACT,
} from '../modules/stand-in-memory-consolidation.mjs'
import {
  assistantMessage,
  createSse,
  handleModelMaintenanceRequest,
  isReplyPredictionRequest,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const USER = 9001
const CHAT = '[data-testid="stand-in-conversation"]'
const RECEIPT = 'MEMORY_TIMER_SOURCE_RECEIVED'

export function createDesktopScenario({ uiTimeoutMs, modelResponseTimeoutMs, captureScreenshot }) {
  const review = createMemoryConsolidation({
    uiTimeoutMs,
    modelResponseTimeoutMs,
    autoComplete: true,
  })
  let active = false
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleModelMaintenanceRequest(body, response)) return true
      if (review.handleModel(body, response)) return true
      if (
        !active ||
        isReplyPredictionRequest(body) ||
        !JSON.stringify(body.input ?? []).includes(MEMORY_HISTORY_FACT)
      )
        return false
      const id = `memory-timer-source-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([responseCreated(id), assistantMessage(RECEIPT), responseCompleted(id)])
      )
      return true
    },
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const original = await rpc('runtime.stand_in.personal.get', { userId: USER })
      let schedule
      try {
        await rpc('runtime.stand_in.personal.save', {
          userId: USER,
          settings: {
            ...original,
            primary: { prompt: '', preferences: '', ...original.primary, enabled: true },
          },
        })
        await ensureExperimentalFeaturesEnabled(control)
        await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
        await control.command('waitFor', CHAT)
        await selectE2EModel(control, undefined, undefined, CHAT)
        active = true
        await control.command('fill', `${CHAT} [data-testid="chat-message-input"]`, {
          value: MEMORY_HISTORY_FACT,
        })
        await control.command('waitFor', `${CHAT} [data-testid="send-message-button"]:enabled`)
        await control.command('press', `${CHAT} [data-testid="chat-message-input"]`, {
          key: 'Enter',
        })
        await control.command('waitFor', CHAT, { text: RECEIPT, timeoutMs: modelResponseTimeoutMs })
        schedule = await until(
          async () =>
            (await rpc('runtime.automations.list', {})).items.find(
              item =>
                item.taskRequest?.standInOwner?.userId === USER &&
                item.taskRequest?.standInCalendar?.template === 'memory_review'
            ),
          Boolean,
          'Native memory review provisioning',
          45000
        )
        const settings = await rpc('runtime.stand_in.personal.get', { userId: USER })
        await rpc('runtime.stand_in.personal.save', {
          userId: USER,
          settings: { ...settings, primary: { ...settings.primary, enabled: false } },
        })
        const deadline = new Date(Date.now() + 2000).toISOString()
        review.activate()
        await rpc('runtime.automations.update', {
          automation: {
            ...schedule,
            enabled: true,
            schedule: { type: 'one_time', execute_at: deadline },
          },
        })
        const run = await until(
          async () =>
            (await rpc('runtime.automation_runs.list', { automationId: schedule.id })).items.find(
              row => Date.parse(row.scheduledFor) === Date.parse(deadline)
            ),
          row => ['succeeded', 'failed', 'cancelled', 'needs_attention'].includes(row?.status),
          'The real scheduler must finish memory review while intake is paused',
          90000
        )
        assert.equal(run.trigger, 'scheduled')
        assert.equal(run.status, 'succeeded', JSON.stringify(run))
        assert.ok(run.taskId)
        assert.notEqual(run.taskId, `stand-in-chat-${USER}-primary`)
        assert.ok(review.result.committed)
        assert.ok(review.result.saved)
        const memories = (await rpc('runtime.stand_in.memory.list', { userId: USER })).items
        assert.deepEqual(
          memories.find(row => row.id === review.result.saved.id),
          review.result.saved
        )
        assert.equal(
          (await rpc('runtime.stand_in.personal.get', { userId: USER })).primary.enabled,
          false
        )
        for (const id of [
          'personal-stand-in-button',
          'stand-in-settings-open',
          'stand-in-primary-connections-open',
          'stand-in-time-connections',
          `automation-open-${schedule.id}`,
          `automation-run-open-${run.id}`,
        ]) {
          if (id === 'stand-in-settings-open') await openStandInSettings(control)
          else await control.command('clickWhenEnabled', `[data-testid="${id}"]`)
        }
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: 'Memory consolidation evidence committed.',
        })
        await captureScreenshot(control, 'memory-timer-paused-intake.png')
      } finally {
        active = false
        if (schedule)
          await rpc('runtime.automations.toggle', { automationId: schedule.id, enabled: false })
        if (review.result.saved)
          await rpc('runtime.stand_in.memory.delete', {
            userId: USER,
            id: review.result.saved.id,
            version: review.result.saved.version,
          })
        const current = await rpc('runtime.stand_in.personal.get', { userId: USER })
        await rpc('runtime.stand_in.personal.save', {
          userId: USER,
          settings: { ...original, version: current.version },
        })
      }
    },
  }
}
