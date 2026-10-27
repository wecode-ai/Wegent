import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { selectE2EModel } from '../modules/shared.mjs'
import { waitForBoardValue } from '../modules/collaboration-board-flows.mjs'
import {
  assistantMessage,
  createSse,
  isReplyPredictionRequest,
  readRequestBody,
  responseCompleted,
  responseCreated,
  telemetryEvents,
} from '../modules/response-protocol.mjs'

const USER = 9001
const OFFLINE_USER = 9101
const MARKER = 'STAND_IN_TELEMETRY_PRIVATE_INPUT'
const COMPLETE = 'STAND_IN_TELEMETRY_COMPLETE'
const CHAT = '[data-testid="stand-in-conversation"]'

export function createDesktopScenario({ uiTimeoutMs, modelResponseTimeoutMs }) {
  return {
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (isReplyPredictionRequest(body) || !JSON.stringify(body.input).includes(MARKER))
        return false
      const id = `stand-in-telemetry-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([responseCreated(id), assistantMessage(COMPLETE), responseCompleted(id)])
      )
      return true
    },
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      await ensureExperimentalFeaturesEnabled(control)
      // An unobserved account models an Executor whose desktop consumer is disconnected.
      await rpc('runtime.stand_in.telemetry.configure', { userId: OFFLINE_USER, enabled: true })
      const offline = await rpc('runtime.stand_in.personal.get', { userId: OFFLINE_USER })
      offline.roles[0].prompt = MARKER
      await rpc('runtime.stand_in.personal.save', { userId: OFFLINE_USER, settings: offline })
      const catalog = await rpc('runtime.runner.catalog', {})
      const model = catalog.models.find(model => model.runtime === 'codex' && model.is_default)
      assert.ok(model, 'The real Executor must expose the seeded Codex model')
      await rpc('runtime.stand_in.conversation', {
        userId: OFFLINE_USER,
        message: MARKER,
        options: {
          modelId: model.local_model_id,
          modelType: 'runtime',
          modelOptions: { codexProviderId: model.provider },
        },
      })
      await waitForBoardValue(
        async () => {
          const { items } = await rpc('runtime.stand_in.telemetry.list', {
            userId: OFFLINE_USER,
          })
          return items.some(item => item.name === 'stand_in_execution_completed')
        },
        true,
        'Executor must persist the unobserved conversation completion',
        modelResponseTimeoutMs
      )
      const before = await rpc('runtime.stand_in.telemetry.list', { userId: OFFLINE_USER })
      for (const name of [
        'stand_in_configuration_succeeded',
        'stand_in_conversation_succeeded',
        'stand_in_execution_started',
        'stand_in_execution_completed',
      ]) {
        assert.equal(before.items.filter(item => item.name === name).length, 1, name)
      }
      assert.equal(
        before.items.find(item => item.name === 'stand_in_execution_completed').properties.result,
        'success'
      )
      assert.ok(!JSON.stringify(before).includes(MARKER))
      await control.command('reloadMainWindow', 'body')
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]')
      assert.deepEqual(
        await rpc('runtime.stand_in.telemetry.list', { userId: OFFLINE_USER }),
        before
      )
      const ids = before.items.map(item => item.id)
      await rpc('runtime.stand_in.telemetry.ack', { userId: OFFLINE_USER, ids })
      await rpc('runtime.stand_in.telemetry.ack', { userId: OFFLINE_USER, ids })
      assert.deepEqual(
        (await rpc('runtime.stand_in.telemetry.list', { userId: OFFLINE_USER })).items,
        []
      )
      await rpc('runtime.stand_in.telemetry.configure', { userId: OFFLINE_USER, enabled: false })

      await rpc('runtime.stand_in.telemetry.configure', { userId: USER, enabled: true })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('click', '[data-testid="collaboration-primary-stand-in"]')
      await control.command('waitFor', CHAT)
      await control.awaitTelemetryEvent('stand_in_opened')
      await selectE2EModel(control, undefined, undefined, CHAT)
      await control.command('fill', `${CHAT} [data-testid="chat-message-input"]`, { value: MARKER })
      await control.command('press', `${CHAT} [data-testid="chat-message-input"]`, {
        key: 'Enter',
      })
      await control.command('waitFor', CHAT, { text: COMPLETE })
      for (const name of [
        'stand_in_conversation_succeeded',
        'stand_in_execution_started',
        'stand_in_execution_completed',
      ]) {
        await control.awaitTelemetryEvent(name)
      }
      const events = control.telemetryRequests
        .flatMap(request => telemetryEvents(request.payload))
        .filter(event => event.event.startsWith('stand_in_'))
      const completed = events.filter(event => event.event === 'stand_in_execution_completed')
      assert.equal(completed.length, 1)
      assert.equal(completed[0].properties.result, 'success')
      assert.ok(completed[0].properties.duration_ms >= 0)
      assert.ok(completed[0].uuid)
      assert.ok(!JSON.stringify(events).includes(MARKER))
      for (const event of events) {
        for (const key of [
          'userId',
          'deviceId',
          'taskId',
          'standInId',
          'prompt',
          'message',
          'path',
        ]) {
          assert.ok(!Object.hasOwn(event.properties, key), `Unexpected private property: ${key}`)
        }
      }
    },
  }
}
