import assert from 'node:assert/strict'
import { ensureExperimentalFeaturesEnabled } from './preferences-automation-flows.mjs'
import { openConnectionTypePicker } from './stand-in-flows.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'

/** Exercise scope selection through the real renderer, RPC, provider and local settings store. */
export async function verifyStandInResourceScopes(control, rpc, providerId) {
  const user = 9001
  const original = await rpc(control, 'runtime.stand_in.personal.get', { userId: user })
  const prefix = `stand-in-connection-${providerId}`
  const open = async () => {
    await control.command('clickWhenEnabled', '[data-testid="stand-in-settings-open"]')
    await control.command('click', '[data-testid="stand-in-primary-connections-open"]')
    await openConnectionTypePicker(control)
    await control.command(
      'clickWhenEnabled',
      `[data-testid="stand-in-add-${providerId}-connection"]`
    )
    await control.command('waitFor', `[data-testid="${prefix}-connections"]`)
    if (Number(await control.command('getElementCount', `[data-testid="${prefix}-add"]`)) > 0)
      await control.command('clickWhenEnabled', `[data-testid="${prefix}-add"]`)
    await control.command('waitFor', `[data-testid="${prefix}-scope-all"]`)
  }
  try {
    await ensureExperimentalFeaturesEnabled(control)
    await control.command('click', '[data-testid="workspace-tab-select-fixed-task"]')
    await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
    await open()
    await control.command('waitFor', `[data-testid="${prefix}-scope-all"]:checked`)
    assert.equal(await control.command('getElementCount', `[data-testid="${prefix}-query"]`), '0')
    await control.command('click', `[data-testid="${prefix}-add-all"]`)
    await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-save"]')
    await control.command('waitFor', '[data-testid="stand-in-primary-profile"]', { visible: false })
    const all = await rpc(control, 'runtime.stand_in.personal.get', { userId: user })
    assert.deepEqual(
      all.primary.connections
        .filter(row => row.providerId === providerId)
        .map(row => [row.id, row.scope, row.profile, row.kind]),
      [['*', 'all', 'fixture', 'record']]
    )
    await open()
    await control.command('click', `[data-testid="${prefix}-scope-selected"]`)
    await control.command('fill', `[data-testid="${prefix}-query"]`, { value: 'batch' })
    await control.command('click', `[data-testid="${prefix}-search"]`)
    await control.command('waitFor', `[data-testid="${prefix}-result-record-2"]`)
    await control.command('click', `[data-testid="${prefix}-select-results"]`)
    const beforeAdd = await rpc(control, 'runtime.stand_in.personal.get', { userId: user })
    assert.equal(beforeAdd.version, all.version, 'Selection is a draft until saved')
    await control.command('click', `[data-testid="${prefix}-add-selected"]`)
    await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-save"]')
    await control.command('waitFor', '[data-testid="stand-in-primary-profile"]', { visible: false })
    const selected = await rpc(control, 'runtime.stand_in.personal.get', { userId: user })
    const rows = selected.primary.connections.filter(row => row.providerId === providerId)
    assert.deepEqual(
      rows.map(row => row.id),
      ['record-1', 'record-2']
    )
    assert.ok(
      rows.every(
        row => row.scope === undefined && row.profile === 'fixture' && row.kind === 'record'
      )
    )
  } finally {
    const current = await rpc(control, 'runtime.stand_in.personal.get', { userId: user })
    await rpc(control, 'runtime.stand_in.personal.save', {
      userId: user,
      settings: { ...original, version: current.version },
    })
  }
}

/** Calendar persistence uses the real scheduler store without dispatching an execution. */
export async function verifyStandInCalendarPolicy(control, rpc) {
  const name = 'Connection calendar policy'
  const original = await rpc(control, 'runtime.stand_in.personal.get', { userId: 9001 })
  let id
  let ordinaryId
  try {
    await reloadMainWindow(control, 'The restored personal settings did not reload')
    await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
    await control.command('waitFor', '[data-testid="stand-in-overview"]')
    await control.command('clickWhenEnabled', '[data-testid="stand-in-settings-open"]')
    await control.command('click', '[data-testid="stand-in-primary-connections-open"]')
    await openConnectionTypePicker(control)
    await control.command('click', '[data-testid="stand-in-time-connections"]')
    await control.command(
      'waitFor',
      '[data-testid="stand-in-calendar-policy"][aria-checked="false"]'
    )
    await control.command('click', '[data-testid="stand-in-calendar-policy"]')
    await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-save"]')
    await control.command('waitFor', '[data-testid="stand-in-primary-profile"]', { visible: false })
    const policy = await rpc(control, 'runtime.stand_in.personal.get', { userId: 9001 })
    assert.equal(policy.primary.calendar.policy.immediate, true)
    await control.command('clickWhenEnabled', '[data-testid="stand-in-settings-open"]')
    await control.command('click', '[data-testid="stand-in-primary-connections-open"]')
    await openConnectionTypePicker(control)
    await control.command('click', '[data-testid="stand-in-time-connections"]')
    await control.command('click', '[data-testid="create-automation-button"]')
    assert.equal(
      await control.command('getElementCount', '[data-testid="automation-goal-switch"]'),
      '0'
    )
    assert.equal(
      await control.command('getElementCount', '[data-testid="automation-conversation-mode"]'),
      '0'
    )
    await control.command('fill', '[data-testid="automation-name-input"]', { value: name })
    await control.command('fill', '[data-testid="automation-prompt-input"]', {
      value: 'Review the project’s outstanding items.',
    })
    await control.command('clickWhenEnabled', '[data-testid="automation-save-button"]')
    await control.command('waitFor', '[data-testid="automation-list-pane"]')
    const saved = (await rpc(control, 'runtime.automations.list', {})).items.find(
      item => item.name === name
    )
    assert.ok(saved, 'Calendar event must persist through the real automation RPC')
    id = saved.id
    assert.deepEqual(saved.taskRequest.standInOwner, { userId: 9001, roleId: '@primary' })
    assert.deepEqual(saved.taskRequest.standInCalendar, {})
    assert.equal(saved.prompt, 'Review the project’s outstanding items.')
    assert.equal(saved.conversationMode, 'independent')
    assert.equal(saved.taskRequest.initialGoal, undefined)
    assert.equal(saved.taskPayload.executionRequest, undefined)
    const taskRequest = { ...saved.taskRequest }
    delete taskRequest.standInCalendar
    delete taskRequest.standInOwner
    const created = await rpc(control, 'runtime.automations.create', {
      automation: { ...saved, id: '', version: 0, name: 'Independent scheduled work', taskRequest },
    })
    ordinaryId = created.automation.id
    await control.command('click', '[data-testid="automation-button"]')
    await control.command('waitFor', '[data-testid="personal-stand-in-button"]')
    await control.command('waitFor', `[data-testid="automation-open-${ordinaryId}"]`)
    assert.equal(
      await control.command('getElementCount', `[data-testid="automation-open-${id}"]`),
      '0'
    )
    await control.command('click', `[data-testid="automation-open-${ordinaryId}"]`)
    await control.command('waitFor', '[data-testid="automation-goal-switch"]')
    await control.command('waitFor', '[data-testid="automation-conversation-mode"]')
    await control.command('navigate', 'body', { value: '/stand-in?view=scheduled' })
    await control.command('waitFor', `[data-testid="automation-open-${id}"]`)
    assert.equal(
      await control.command('getElementCount', `[data-testid="automation-open-${ordinaryId}"]`),
      '0'
    )
    const retained = (await rpc(control, 'runtime.automations.list', {})).items.find(
      item => item.id === id
    )
    assert.deepEqual(retained, saved, 'Using ordinary schedules must not mutate calendar entries')
    await control.command('click', `[data-testid="automation-open-${id}"]`)
    await control.command('waitFor', '[data-testid="automation-prompt-input"]')
    assert.equal(
      await control.command('getElementCount', '[data-testid="automation-immediate-switch"]'),
      '0'
    )
    await control.command('click', '[data-testid="automation-detail-close"]')
    await control.command('click', '[data-testid="stand-in-primary-cancel"]')
  } finally {
    if (id) await rpc(control, 'runtime.automations.delete', { automationId: id })
    if (ordinaryId) await rpc(control, 'runtime.automations.delete', { automationId: ordinaryId })
    const current = await rpc(control, 'runtime.stand_in.personal.get', { userId: 9001 })
    await rpc(control, 'runtime.stand_in.personal.save', {
      userId: 9001,
      settings: { ...original, version: current.version },
    })
  }
}
