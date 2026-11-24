import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { requestExecutor } from './executor-rpc.mjs'
import { verifyStandInDelegationVisual } from './stand-in-delegation-visual.mjs'
import { openStandInSettings } from './stand-in-profile-navigation.mjs'
import { openConnectionTypePicker } from './stand-in-flows.mjs'

const id = testId => `[data-testid="${testId}"]`
const dingtalk = name => id(`stand-in-dingtalk-${name}`)
const delegation = name => id(`stand-in-delegation-${name}`)
const provider = '@wegent/dsh-connection-dingtalk/dingtalk'
const profile = 'fixture-org:fixture-user'
const switchedProfile = 'other-org:fixture-user'
const accountId = (selectedProfile, organization) =>
  createHash('sha256')
    .update(JSON.stringify([selectedProfile, organization, 'fixture-user']))
    .digest('hex')
const selectedSources = primary =>
  primary.connections?.filter(row => row.providerId === provider) ?? []

async function openDingTalk(control) {
  await openStandInSettings(control)
  await control.command('clickWhenEnabled', id('stand-in-primary-connections-open'))
  await openConnectionTypePicker(control)
  await control.command('clickWhenEnabled', id('stand-in-add-dingtalk-connection'))
  await control.command('waitFor', dingtalk('account'), { text: 'Fixture · Fixture Organization' })
}

async function selectSource(control, query, selected, unselected) {
  await control.command('fill', dingtalk('query'), { value: query })
  await control.command('clickWhenEnabled', dingtalk('search'))
  await control.command('waitFor', dingtalk(`result-${unselected}`))
  await control.command('clickWhenEnabled', dingtalk(`result-${selected}`))
  await control.command('clickWhenEnabled', dingtalk('add-selected'))
  await control.command('waitFor', dingtalk(`remove-${selected}`))
}

export async function verifyStandInDingTalkDelegation(control, userId, fixture, options) {
  const load = () =>
    requestExecutor(control, 'runtime.stand_in.personal.get', { userId }, options.uiTimeoutMs)
  await fixture.setAuthState('scoped-ready')
  const initial = (await load()).primary
  await control.command('clickWhenEnabled', id('stand-in-primary-open'))
  await openDingTalk(control)
  await control.command('waitFor', `${delegation('enable')}:disabled`)
  assert.equal(await control.command('getElementCount', dingtalk('authorize')), '0')
  for (const template of ['document', 'schedule', 'process']) {
    await control.command('waitFor', `${delegation(`template-${template}`)}[aria-checked="true"]`)
  }
  await verifyStandInDelegationVisual(control, options)
  await selectSource(control, 'Scoped Group', 'scoped-group', 'other-group')
  await control.command('clickWhenEnabled', dingtalk('add'))
  await control.command('select', dingtalk('kind'), { value: 'direct' })
  await selectSource(control, 'Scoped Contact', 'scoped-contact', 'other-contact')
  await control.command('clickWhenEnabled', delegation('template-document'))
  await control.command('waitFor', `${delegation('template-document')}[aria-checked="false"]`)
  await control.command('waitFor', `${delegation('template-schedule')}[aria-checked="true"]`)
  await control.command('waitFor', `${delegation('template-process')}[aria-checked="true"]`)
  assert.deepEqual((await load()).primary, initial, 'Editing scope stays in the draft')

  await control.command('clickWhenEnabled', dingtalk('save-scope'))
  await control.command('waitFor', `${delegation('enable')}:enabled`)
  await control.command('waitFor', `${dingtalk('save-scope')}:disabled`)
  const saved = (await load()).primary
  assert.ok(saved.model?.model_id, 'Saving scope persists an available model')
  assert.equal(saved.delegation.authorized, false)
  assert.equal(saved.delegation.paused, true)
  assert.equal(saved.delegation.profile, profile)
  assert.equal(saved.delegation.accountId, accountId(profile, 'fixture-org'))
  assert.equal(saved.delegation.organizationId, 'fixture-org')
  assert.deepEqual(
    selectedSources(saved).map(row => [row.kind, row.id, row.profile, row.accountId]),
    [
      ['group', 'scoped-group', profile, saved.delegation.accountId],
      ['direct', 'scoped-contact', profile, saved.delegation.accountId],
    ]
  )
  assert.deepEqual(saved.delegation.templates, { document: false, schedule: true, process: true })
  assert.deepEqual(await fixture.operations(), [], 'Saving does not read messages, send or log in')

  await control.command('clickWhenEnabled', id('stand-in-primary-profile-close'))
  await control.command('waitFor', id('stand-in-profile-panel'), { visible: false })
  await openDingTalk(control)
  await control.command('waitFor', id('stand-in-profile-panel'), { text: 'Scoped Group' })
  await control.command('waitFor', id('stand-in-profile-panel'), { text: 'Scoped Contact' })
  const reopened = (await load()).primary
  assert.deepEqual(reopened.delegation, saved.delegation)
  assert.deepEqual(reopened.model, saved.model)

  await fixture.setAuthState('scoped-read-denied')
  try {
    await control.command('clickWhenEnabled', delegation('enable'))
    await control.command('waitFor', `${id('stand-in-profile-panel')} [role="alert"]`, {
      text: '所选会话缺少读取权限',
    })
    assert.deepEqual((await load()).primary.delegation, saved.delegation)
  } finally {
    await fixture.setAuthState('scoped-ready')
  }

  const enableRequestedAt = Date.now()
  await control.command('clickWhenEnabled', delegation('enable'))
  await control.command('waitFor', `${delegation('toggle-pause')}:enabled`)
  const active = (await load()).primary
  assert.equal(active.delegation.authorized, true)
  assert.equal(active.delegation.paused, false)
  assert.equal(active.enabled, true)
  for (const row of selectedSources(active)) {
    const boundary = Date.parse(row.enabledAfter)
    assert.ok(boundary >= enableRequestedAt && boundary <= Date.now(), 'Intake begins on enable')
  }
  const operations = await fixture.operations()
  assert.ok(operations.includes('selected-group-mentions'))
  assert.ok(operations.includes('selected-direct-messages'))
  assert.ok(!operations.includes('login') && !operations.includes('send'))

  await control.command('clickWhenEnabled', delegation('toggle-pause'))
  await control.command('waitFor', `${delegation('toggle-pause')}:enabled`, { text: '恢复' })
  const paused = (await load()).primary
  assert.equal(paused.delegation.authorized, true)
  assert.equal(paused.delegation.paused, true)
  assert.deepEqual(
    selectedSources(paused).map(row => row.id),
    selectedSources(saved).map(row => row.id)
  )
  assert.deepEqual(paused.delegation.templates, saved.delegation.templates)

  await control.command('clickWhenEnabled', dingtalk('switch-account'))
  await control.command('clickWhenEnabled', dingtalk(`select-account-${switchedProfile}`))
  await control.command('waitFor', dingtalk('account'), { text: 'Fixture · Other Organization' })
  await control.command('clickWhenEnabled', dingtalk('confirm-account'))
  await control.command('waitFor', dingtalk('confirm-account'), { visible: false })
  await control.command('waitFor', `${delegation('enable')}:disabled`)
  const switched = (await load()).primary
  assert.equal(switched.delegation.profile, switchedProfile)
  assert.equal(switched.delegation.accountId, accountId(switchedProfile, 'other-org'))
  assert.equal(switched.delegation.authorized, false)
  assert.equal(switched.delegation.paused, true)
  assert.deepEqual(selectedSources(switched), [])
  const finalOperations = await fixture.operations()
  assert.ok(!finalOperations.includes('login') && !finalOperations.includes('send'))
}
