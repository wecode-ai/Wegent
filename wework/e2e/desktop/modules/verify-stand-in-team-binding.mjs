import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { openStandInSettings } from './stand-in-profile-navigation.mjs'
import { seedStandInRoleFixture } from './stand-in-role-fixture.mjs'

import {
  assistantMessage,
  createSse,
  isReplyPredictionRequest,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'

const message = 'Review the release using my saved team.'
const instruction = 'Check the release as the bound review team.'
const delivery = 'Bound review team verified the release.'

export async function handleBoundReviewRequest(req, res, url) {
  if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname)) return false
  const body = await readRequestBody(req)
  if (isReplyPredictionRequest(body) || !JSON.stringify(body.input ?? []).includes(message))
    return false
  assert.ok(
    JSON.stringify(body).includes(instruction),
    'The native turn must receive the saved Team instructions'
  )
  const id = 'bound-review-delivery'
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  res.end(createSse([responseCreated(id), assistantMessage(delivery), responseCompleted(id)]))
  return true
}

export async function verifyStandInTeamBinding(
  control,
  { uiTimeoutMs, modelResponseTimeoutMs, captureScreenshot }
) {
  const userId = 9001
  const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const settings = await seedStandInRoleFixture(rpc, userId)
  const role = settings.roles.find(row => row.id === 'default')
  const catalog = await rpc('runtime.runner.catalog', {})
  const model = catalog.models.find(row => row.runtime === 'codex' && row.is_default)
  assert.ok(model, 'The personal assistant requires its configured Codex model')
  const agent = await rpc('chat_agents.create', {
    project_id: 'default-work-items',
    agent: {
      name: 'binding-review-team',
      runtime: 'codex',
      created_by_user_id: userId,
      system_prompt: instruction,
      execution_policy: { mode: 'fixed', environment_id: settings.executionDeviceId },
      model_policy: {
        mode: 'fixed',
        model: { runtime: model.runtime, provider: model.provider, model_id: model.model_id },
      },
    },
  })
  const click = id =>
    control.command('clickWhenEnabled', `[data-testid="${id}"]`, { timeoutMs: 5000 })
  const read = async () =>
    (await rpc('runtime.stand_in.personal.get', { userId })).roles.find(row => row.id === role.id)
  const open = async () => {
    await click(`stand-in-overview-role-${role.id}`)
    await openStandInSettings(control)
    await click('stand-in-advanced-open')
    await control.command('waitFor', '[data-testid="stand-in-team-binding"]', {
      visible: true,
      timeoutMs: 5000,
    })
  }
  await open()
  await click('stand-in-team-binding')
  await control.command('waitFor', `[data-testid="stand-in-team-binding-option-${agent.id}"]`, {
    visible: true,
    timeoutMs: 5000,
  })
  await captureScreenshot(control, 'assistant-team-options.png')
  await click(`stand-in-team-binding-option-${agent.id}`)
  assert.equal(
    (await read()).teamRef,
    role.teamRef,
    'Changing the draft should preserve the saved binding'
  )
  await click('stand-in-back')
  await click('stand-in-save')
  await control.command('waitFor', '[data-testid="stand-in-profile-panel"]', {
    visible: false,
    timeoutMs: 5000,
  })
  assert.equal((await read()).teamRef, agent.id)
  await open()
  await control.command('waitFor', '[data-testid="stand-in-team-binding"]', {
    text: agent.display_name || agent.name,
    timeoutMs: 5000,
  })
  await captureScreenshot(control, 'assistant-team-saved.png')
  await click('stand-in-back')
  await click('stand-in-close')
  const chat =
    '[data-workspace-tab-content][aria-hidden="false"] [data-testid="stand-in-conversation"]'
  await control.command('fill', chat + ' [data-testid="chat-message-input"]', { value: message })
  await control.command('clickWhenEnabled', chat + ' [data-testid="send-message-button"]', {
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', chat + ' [data-testid="message-assistant"]', {
    text: delivery,
    timeoutMs: modelResponseTimeoutMs,
  })
  await captureScreenshot(control, 'assistant-team-delivery.png', chat)
}
