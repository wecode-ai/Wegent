import assert from 'node:assert/strict'
import { verifyAssistantTeamCreation } from './assistant-team-creation.mjs'
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
const instruction = 'Check the release as the release assistant.'
const delivery = 'Release assistant verified the release.'

export async function handleAssistantReviewRequest(req, res, url) {
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

export async function verifyAssistantTeam(
  control,
  { uiTimeoutMs, modelResponseTimeoutMs, captureScreenshot }
) {
  const userId = 9001
  const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const settings = await seedStandInRoleFixture(rpc, userId)
  await verifyAssistantTeamCreation(control, rpc, settings, captureScreenshot)
  const role = settings.roles.find(row => row.id === 'default')
  assert.ok(role?.teamRef, 'The saved assistant must already have its own Team')
  const permission =
    role.taskPermissions?.permissionMode === 'workspace-write' ? 'read-only' : 'workspace-write'
  const click = id =>
    control.command('clickWhenEnabled', `[data-testid="${id}"]`, { timeoutMs: 5000 })
  const read = async () =>
    (await rpc('runtime.stand_in.personal.get', { userId })).roles.find(row => row.id === role.id)
  const open = async () => {
    await click(`stand-in-overview-role-${role.id}`)
    await openStandInSettings(control)
  }
  const openEnvironment = async () => {
    await click('stand-in-advanced-open')
    await control.command('waitFor', '[data-testid="stand-in-task-permissions"]')
    assert.equal(
      await control.command('getElementCount', '[data-testid="stand-in-team-binding"]'),
      '0'
    )
  }
  await open()
  await control.command('fill', '[data-testid="stand-in-prompt"]', { value: instruction })
  await openEnvironment()
  await captureScreenshot(control, 'assistant-team-environment.png')
  await control.command(
    'clickWhenEnabled',
    '[data-testid="stand-in-task-permissions"] [data-testid="permission-mode-menu-button"]'
  )
  await click('permission-mode-' + permission)
  await click('stand-in-back')
  await click('stand-in-save')
  await control.command('waitFor', '[data-testid="stand-in-profile-panel"]', {
    visible: false,
    timeoutMs: 5000,
  })
  const saved = await read()
  assert.equal(saved.teamRef, role.teamRef)
  assert.equal(saved.taskPermissions.permissionMode, permission)
  assert.equal(saved.prompt, instruction)
  await open()
  assert.equal(await control.command('getValue', '[data-testid="stand-in-prompt"]'), instruction)
  await openEnvironment()
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
