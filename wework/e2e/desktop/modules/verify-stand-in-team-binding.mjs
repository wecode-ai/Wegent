import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { openStandInSettings } from './stand-in-profile-navigation.mjs'
import { seedStandInRoleFixture } from './stand-in-role-fixture.mjs'

export async function verifyStandInTeamBinding(control, { uiTimeoutMs, captureScreenshot }) {
  const userId = 9001
  const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const settings = await seedStandInRoleFixture(rpc, userId)
  const role = settings.roles.find(row => row.id === 'default')
  const agent = await rpc('chat_agents.create', {
    project_id: 'default-work-items',
    agent: { name: 'binding-review-team', runtime: 'codex', created_by_user_id: userId },
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
}
