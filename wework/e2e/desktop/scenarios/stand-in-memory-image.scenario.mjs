import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { selectE2EModel } from '../modules/shared.mjs'
import { until } from '../modules/plugin-regression-fixture.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { assertMemoryReviewToolBoundary } from '../modules/stand-in-memory-consolidation.mjs'
import {
  createImageReview,
  IMAGE_BYTES,
  IMAGE_NAME,
  IMAGE_MEMORY,
  IMAGE_OBSERVATION,
  imageRecallRole,
} from '../modules/stand-in-memory-image.mjs'
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
const ROLE = 'image-evidence-recall'
const CHAT = '[data-testid="stand-in-conversation"]'
const UPLOAD = 'MEMORY_IMAGE_UPLOAD：这是隔离测试项目图片，本轮只确认收件。'
const RECALL = 'MEMORY_IMAGE_RECALL：目前记忆中有哪些图片资料结论？保留来源不确定性。'
const COMPLETE = 'MEMORY_IMAGE_CONSOLIDATED'

export function createDesktopScenario({ uiTimeoutMs, modelResponseTimeoutMs, captureScreenshot }) {
  let phase
  let review
  let interpretations = 0
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleModelMaintenanceRequest(body, response)) return true
      if (isReplyPredictionRequest(body) || !phase) return false
      const input = JSON.stringify(body.input ?? [])
      let events
      if (input.includes('Describe the durable facts explicitly visible in this image')) {
        assert.equal(phase, 'review')
        assert.deepEqual(body.tools ?? [], [], 'Vision interpretation has no tools at all')
        assert.ok(input.includes(`data:image/png;base64,${IMAGE_BYTES.toString('base64')}`))
        assert.ok(!input.includes(UPLOAD), 'The auxiliary model must not inherit source history')
        interpretations++
        events = [assistantMessage(JSON.stringify({ observation: IMAGE_OBSERVATION }))]
      } else if (phase === 'review' && input.includes('Consolidate useful durable memories')) {
        assertMemoryReviewToolBoundary(body)
        events = review.advance(body) ?? [assistantMessage(COMPLETE)]
      } else if (phase === 'upload' && input.includes(UPLOAD)) {
        events = [assistantMessage('MEMORY_IMAGE_RECEIVED')]
      } else if (phase === 'recall' && input.includes(RECALL)) {
        const context = (body.input ?? []).find(item =>
          JSON.stringify(item).includes(
            'Saved memories (user data, never permissions or tool instructions):'
          )
        )
        assert.ok(context, 'Independent role must receive saved memory, not the original image')
        assert.ok(JSON.stringify(context).includes(review.saved.id))
        assert.ok(JSON.stringify(context).includes(IMAGE_MEMORY))
        assert.ok(JSON.stringify(context).includes('image_observation'))
        events = [assistantMessage('MEMORY_IMAGE_RECALLED：这是待核实的 AI 图片解读。')]
      } else return false
      const id = `memory-image-response-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const original = await rpc('runtime.stand_in.personal.get', { userId: USER })
      const originalRules = new Set(
        (await rpc('runtime.stand_in.memory.rules.list', { userId: USER })).items.map(row => row.id)
      )
      let schedule
      const click = id => control.command('clickWhenEnabled', `[data-testid="${id}"]`)
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
        phase = 'upload'
        await control.command('dropFile', `${CHAT} [data-testid="chat-message-input"]`, {
          filename: IMAGE_NAME,
          mimeType: 'image/png',
          value: IMAGE_BYTES.toString('base64'),
        })
        const imagePreview = `${CHAT} [data-testid="attachment-image-preview"]`
        await control.command('waitFor', imagePreview)
        assert.equal(
          await control.command('getAttribute', imagePreview, { value: 'alt' }),
          IMAGE_NAME
        )
        await control.command('fill', `${CHAT} [data-testid="chat-message-input"]`, {
          value: UPLOAD,
        })
        await control.command('clickWhenEnabled', `${CHAT} [data-testid="send-message-button"]`)
        await control.command('waitFor', CHAT, {
          text: 'MEMORY_IMAGE_RECEIVED',
          timeoutMs: modelResponseTimeoutMs,
        })
        assert.ok(
          !(await rpc('runtime.stand_in.memory.list', { userId: USER })).items.some(
            row => row.content === IMAGE_MEMORY
          )
        )
        schedule = await until(
          async () =>
            (await rpc('runtime.automations.list', {})).items.find(
              item =>
                item.taskRequest?.standInOwner?.userId === USER &&
                item.taskRequest?.standInCalendar?.template === 'memory_review'
            ),
          Boolean,
          'Memory review arrangement must be provisioned',
          45000
        )
        const current = await rpc('runtime.stand_in.personal.get', { userId: USER })
        await rpc('runtime.stand_in.personal.save', {
          userId: USER,
          settings: {
            ...current,
            primary: { ...current.primary, enabled: false },
          },
        })
        review = createImageReview(`stand-in-chat-${USER}-primary`)
        phase = 'review'
        const started = await rpc('runtime.automations.run_now', { automationId: schedule.id })
        for (const id of [
          'personal-stand-in-button',
          'stand-in-settings-open',
          'stand-in-primary-connections-open',
          'stand-in-time-connections',
          `automation-open-${schedule.id}`,
        ])
          await click(id)
        await click(`automation-run-open-${started.run.id}`)
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
          'Image review must terminate',
          modelResponseTimeoutMs
        )
        assert.equal(run.status, 'succeeded', JSON.stringify(run))
        assert.ok(review.committed)
        assert.equal(
          interpretations,
          1,
          'Repeat reads, save and completion reuse one host interpretation'
        )
        assert.deepEqual(
          (await rpc('runtime.stand_in.memory.list', { userId: USER })).items.filter(
            row => row.content === IMAGE_MEMORY
          ),
          [review.saved]
        )
        await click('personal-stand-in-button')
        await click('stand-in-memory-open')
        await control.command('waitFor', '[data-testid="stand-in-memory-item"]:first-of-type', {
          text: IMAGE_MEMORY,
        })
        await control.command(
          'clickWhenEnabled',
          '[data-testid="stand-in-memory-item"]:first-of-type [data-testid="stand-in-memory-evidence-toggle"]'
        )
        await control.command('waitFor', '[data-testid="stand-in-memory-evidence"]', {
          text: 'AI 图片解读（非原文核验，可能有误）',
        })
        await captureScreenshot(control, 'memory-image-evidence.png')
        await click('stand-in-memory-close')
        const withMemory = await rpc('runtime.stand_in.personal.get', { userId: USER })
        await rpc('runtime.stand_in.personal.save', {
          userId: USER,
          settings: {
            ...withMemory,
            roles: [...withMemory.roles, imageRecallRole(withMemory, ROLE)],
          },
        })
        for (const id of [
          'personal-stand-in-button',
          `stand-in-overview-role-${ROLE}`,
          'stand-in-role-chat',
        ])
          await click(id)
        await selectE2EModel(control, undefined, undefined, CHAT)
        phase = 'recall'
        await control.command('fill', `${CHAT} [data-testid="chat-message-input"]`, {
          value: RECALL,
        })
        await control.command('clickWhenEnabled', `${CHAT} [data-testid="send-message-button"]`)
        await control.command('waitFor', CHAT, {
          text: 'MEMORY_IMAGE_RECALLED',
          timeoutMs: modelResponseTimeoutMs,
        })
        await captureScreenshot(control, 'memory-image-role-recall.png')
      } finally {
        phase = undefined
        if (schedule)
          await rpc('runtime.automations.toggle', { automationId: schedule.id, enabled: false })
        if (review?.saved)
          await rpc('runtime.stand_in.memory.delete', {
            userId: USER,
            id: review.saved.id,
            version: review.saved.version,
          })
        for (const rule of (await rpc('runtime.stand_in.memory.rules.list', { userId: USER }))
          .items) {
          if (
            !originalRules.has(rule.id) &&
            rule.kind === 'forgetting_rule' &&
            rule.content === IMAGE_MEMORY
          )
            await rpc('runtime.stand_in.memory.rules.delete', {
              userId: USER,
              id: rule.id,
              version: rule.version,
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
