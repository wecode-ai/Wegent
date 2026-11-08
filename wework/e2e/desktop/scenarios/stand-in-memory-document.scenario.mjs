import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { selectE2EModel } from '../modules/shared.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { assertMemoryReviewToolBoundary } from '../modules/stand-in-memory-consolidation.mjs'
import {
  createDocumentReview,
  memoryDocumentFixture,
  DOCUMENT_NAME,
  DOCUMENT_MEMORY,
} from '../modules/stand-in-memory-document.mjs'
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
const SOURCE = `stand-in-chat-${USER}-primary`
const CHAT = '[data-testid="stand-in-conversation"]'
const UPLOAD = 'MEMORY_DOCUMENT_UPLOAD：这是项目资料，本轮只确认收件。'
const RECEIPT = 'MEMORY_DOCUMENT_RECEIVED'
const COMPLETE = 'MEMORY_DOCUMENT_CONSOLIDATED'

export function createDesktopScenario({ uiTimeoutMs, modelResponseTimeoutMs, captureScreenshot }) {
  let phase
  let review
  let uploaded = false
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleModelMaintenanceRequest(body, response)) return true
      if (isReplyPredictionRequest(body) || !phase) return false
      const input = JSON.stringify(body.input ?? [])
      let events
      if (phase === 'upload' && input.includes(UPLOAD)) {
        uploaded = true
        events = [assistantMessage(RECEIPT)]
      } else if (phase === 'review' && input.includes('Consolidate useful durable memories')) {
        assertMemoryReviewToolBoundary(body)
        events = review.advance(body) ?? [assistantMessage(COMPLETE)]
      } else return false
      const id = `memory-document-response-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
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
        const fixture = await memoryDocumentFixture()
        review = createDocumentReview(SOURCE, fixture.hash)
        phase = 'upload'
        await control.command('dropFile', `${CHAT} [data-testid="chat-message-input"]`, {
          filename: DOCUMENT_NAME,
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          value: fixture.bytes.toString('base64'),
        })
        await control.command('waitFor', `${CHAT} [data-testid="attachment-badge"]`, {
          text: DOCUMENT_NAME,
        })
        await control.command('fill', `${CHAT} [data-testid="chat-message-input"]`, {
          value: UPLOAD,
        })
        await control.command('waitFor', `${CHAT} [data-testid="send-message-button"]:enabled`)
        await control.command('press', `${CHAT} [data-testid="chat-message-input"]`, {
          key: 'Enter',
        })
        await control.command('waitFor', CHAT, { text: RECEIPT, timeoutMs: modelResponseTimeoutMs })
        assert.ok(uploaded)
        const before = (await rpc('runtime.stand_in.memory.list', { userId: USER })).items
        assert.ok(!before.some(row => row.content === DOCUMENT_MEMORY))
        schedule = await until(
          async () =>
            (await rpc('runtime.automations.list', {})).items.find(
              item =>
                item.taskRequest?.standInOwner?.userId === USER &&
                item.taskRequest?.standInCalendar?.template === 'memory_review'
            ),
          Boolean,
          'The native scheduler must provision the memory review',
          45000
        )
        const current = await rpc('runtime.stand_in.personal.get', { userId: USER })
        await rpc('runtime.stand_in.personal.save', {
          userId: USER,
          settings: { ...current, primary: { ...current.primary, enabled: false } },
        })
        phase = 'review'
        const started = await rpc('runtime.automations.run_now', { automationId: schedule.id })
        assert.ok(started.run?.id)
        for (const name of [
          'personal-stand-in-button',
          'stand-in-settings-open',
          'stand-in-primary-connections-open',
          'stand-in-time-connections',
          `automation-open-${schedule.id}`,
        ]) {
          await control.command('clickWhenEnabled', `[data-testid="${name}"]`)
        }
        await control.command(
          'clickWhenEnabled',
          `[data-testid="automation-run-open-${started.run.id}"]`,
          { timeoutMs: modelResponseTimeoutMs }
        )
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: COMPLETE,
          timeoutMs: modelResponseTimeoutMs,
        })
        const run = await until(
          async () =>
            (await rpc('runtime.automation_runs.list', { automationId: schedule.id })).items.find(
              row => row.id === started.run.id
            ),
          row => ['succeeded', 'failed', 'cancelled'].includes(row?.status),
          'The exact document review run must terminate',
          modelResponseTimeoutMs
        )
        assert.equal(run.status, 'succeeded', JSON.stringify(run))
        assert.notEqual(run.taskId, SOURCE)
        assert.ok(review.committed)
        const after = (await rpc('runtime.stand_in.memory.list', { userId: USER })).items
        assert.deepEqual(
          after.filter(row => row.content === DOCUMENT_MEMORY),
          [review.saved]
        )
        await captureScreenshot(control, 'memory-native-document-consolidated.png')
      } finally {
        phase = undefined
        if (schedule)
          await rpc('runtime.automations.toggle', { automationId: schedule.id, enabled: false })
        for (const row of (
          await rpc('runtime.stand_in.memory.list', { userId: USER })
        ).items.filter(row => row.content === DOCUMENT_MEMORY)) {
          await rpc('runtime.stand_in.memory.delete', {
            userId: USER,
            id: row.id,
            version: row.version,
          })
        }
        const current = await rpc('runtime.stand_in.personal.get', { userId: USER })
        await rpc('runtime.stand_in.personal.save', {
          userId: USER,
          settings: { ...original, version: current.version },
        })
      }
    },
  }
}
