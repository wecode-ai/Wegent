import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { selectE2EModel } from '../modules/shared.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { assertMemoryReviewToolBoundary } from '../modules/stand-in-memory-consolidation.mjs'
import {
  memoryVisualPdfFixture,
  VISUAL_PDF_NAME,
  createUnreadableDocumentReview,
} from '../modules/stand-in-memory-unreadable-document.mjs'
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
const UPLOAD = 'UNREADABLE_PDF_UPLOAD：只确认收件，不保存记忆。'
const COMPLETE = 'UNREADABLE_PDF_REPORTED：PDF 没有可提取文本，覆盖未完成，未推进来源进度。'

export function createDesktopScenario({ uiTimeoutMs, modelResponseTimeoutMs, captureScreenshot }) {
  let review
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleModelMaintenanceRequest(body, response)) return true
      if (isReplyPredictionRequest(body)) return false
      const input = JSON.stringify(body.input ?? [])
      let events
      if (review && input.includes('Consolidate useful durable memories')) {
        assertMemoryReviewToolBoundary(body)
        events = review.advance(body) ?? [assistantMessage(COMPLETE)]
      } else if (input.includes(UPLOAD)) events = [assistantMessage('UNREADABLE_PDF_RECEIVED')]
      else return false
      const id = `unreadable-document-response-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const click = id => control.command('clickWhenEnabled', `[data-testid="${id}"]`)
      const original = await rpc('runtime.stand_in.personal.get', { userId: USER })
      const before = (await rpc('runtime.stand_in.memory.list', { userId: USER })).items
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
        await click('personal-stand-in-button')
        await control.command('waitFor', CHAT)
        await selectE2EModel(control, undefined, undefined, CHAT)
        await control.command('dropFile', `${CHAT} [data-testid="chat-message-input"]`, {
          filename: VISUAL_PDF_NAME,
          mimeType: 'application/pdf',
          value: memoryVisualPdfFixture().toString('base64'),
        })
        await control.command('waitFor', CHAT, { text: VISUAL_PDF_NAME })
        await control.command('fill', `${CHAT} [data-testid="chat-message-input"]`, {
          value: UPLOAD,
        })
        await control.command('clickWhenEnabled', `${CHAT} [data-testid="send-message-button"]`)
        await control.command('waitFor', CHAT, {
          text: 'UNREADABLE_PDF_RECEIVED',
          timeoutMs: modelResponseTimeoutMs,
        })
        schedule = await until(
          async () =>
            (await rpc('runtime.automations.list', {})).items.find(
              row =>
                row.taskRequest?.standInOwner?.userId === USER &&
                row.taskRequest?.standInCalendar?.template === 'memory_review'
            ),
          Boolean,
          'Memory review provisioning',
          45000
        )
        const current = await rpc('runtime.stand_in.personal.get', { userId: USER })
        await rpc('runtime.stand_in.personal.save', {
          userId: USER,
          settings: { ...current, primary: { ...current.primary, enabled: false } },
        })
        for (let attempt = 0; attempt < 2; attempt++) {
          // These are distinct scheduled reviews, not retries of a failed test.
          review = createUnreadableDocumentReview(`stand-in-chat-${USER}-primary`)
          const started = await rpc('runtime.automations.run_now', { automationId: schedule.id })
          assert.ok(started.run?.id)
          for (const id of [
            'personal-stand-in-button',
            'stand-in-settings-open',
            'stand-in-primary-connections-open',
            'stand-in-time-connections',
            `automation-open-${schedule.id}`,
          ])
            await click(id)
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
            row => ['succeeded', 'failed', 'needs_attention', 'cancelled'].includes(row?.status),
            'Incomplete coverage report termination',
            modelResponseTimeoutMs
          )
          assert.equal(run.status, 'succeeded', JSON.stringify(run))
          assert.ok(review.completed)
          assert.deepEqual(
            (await rpc('runtime.stand_in.memory.list', { userId: USER })).items,
            before
          )
        }
        await captureScreenshot(control, 'memory-unreadable-pdf-incomplete.png')
      } finally {
        if (schedule)
          await rpc('runtime.automations.toggle', { automationId: schedule.id, enabled: false })
        const current = await rpc('runtime.stand_in.personal.get', { userId: USER })
        await rpc('runtime.stand_in.personal.save', {
          userId: USER,
          settings: { ...original, version: current.version },
        })
      }
    },
  }
}
