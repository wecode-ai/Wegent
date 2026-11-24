import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { openStandInSettings } from './stand-in-profile-navigation.mjs'
import { openConnectionTypePicker } from './stand-in-flows.mjs'

const id = testId => `[data-testid="${testId}"]`
const dingtalk = name => id(`stand-in-dingtalk-${name}`)
const panel = dingtalk('delegation')
const profile = 'fixture-org:fixture-user'

async function openDelegation(control, initial = false) {
  await openStandInSettings(control)
  await control.command('clickWhenEnabled', id('stand-in-primary-connections-open'))
  await openConnectionTypePicker(control)
  await control.command('clickWhenEnabled', id('stand-in-add-dingtalk-connection'))
  if (initial) await control.command('clickWhenEnabled', dingtalk('setup-selected'))
  await control.command('waitFor', panel)
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

/** Exercise scoped intake through the real desktop settings with an isolated DingTalk boundary. */
export async function verifyStandInDingTalkDelegation(control, userId, uiTimeoutMs, fixture) {
  const load = () =>
    requestExecutor(control, 'runtime.stand_in.personal.get', { userId }, uiTimeoutMs)
  const before = await load()
  assert.equal(before.primary.enabled, true, 'The primary assistant must already be running')
  await control.command('clickWhenEnabled', id('stand-in-primary-open'))
  await openDelegation(control, true)
  await control.command('waitFor', `${panel} [role="status"]`, { text: '账号已验证' })
  assert.equal(await control.command('getElementCount', dingtalk('authorize')), '0')
  await selectSource(control, 'Scoped Group', 'scoped-group', 'other-group')
  await control.command('clickWhenEnabled', dingtalk('add'))
  await control.command('select', dingtalk('kind'), { value: 'direct' })
  await selectSource(control, 'Scoped Contact', 'scoped-contact', 'other-contact')
  await control.command('clickWhenEnabled', dingtalk('template-documentLink'))
  assert.deepEqual((await load()).primary, before.primary, 'Editing scope must remain a draft')

  await control.command('clickWhenEnabled', dingtalk('save-scope'))
  await control.command('waitFor', `${dingtalk('enable')}:enabled`)
  const { dingtalkDelegation: saved, model } = (await load()).primary
  assert.ok(model?.model_id, 'Saving scope must persist an available model')
  assert.equal(saved.enabled, false)
  assert.equal(saved.enabledAfter ?? null, null)
  assert.deepEqual(saved.account, {
    profile,
    accountId: 'fixture-user',
    accountName: 'Fixture',
    organizationId: 'fixture-org',
    organizationName: 'Fixture Organization',
  })
  assert.deepEqual(
    saved.sources.map(({ kind, id, profile }) => [kind, id, profile]),
    [
      ['group', 'scoped-group', profile],
      ['direct', 'scoped-contact', profile],
    ]
  )
  assert.deepEqual(saved.templates, {
    documentLink: false,
    timeLocation: true,
    standardProcess: true,
  })
  assert.deepEqual(await fixture.operations(), [], 'Saving scope must not read, send or log in')

  await control.command('clickWhenEnabled', id('stand-in-primary-profile-close'))
  await control.command('waitFor', id('stand-in-profile-panel'), { visible: false })
  await openDelegation(control)
  await control.command('waitFor', `${panel} li`, { text: 'Scoped Group' })
  await control.command('waitFor', `${panel} li`, { text: 'Scoped Contact' })
  const reopened = (await load()).primary
  assert.deepEqual(reopened.dingtalkDelegation, saved)
  assert.deepEqual(reopened.model, model)

  await fixture.setAuthState('read-denied')
  try {
    await control.command('clickWhenEnabled', dingtalk('enable'))
    await control.command('waitFor', `${panel} [role="alert"]`, { text: '所选会话缺少读取权限' })
    assert.deepEqual((await load()).primary.dingtalkDelegation, saved)
    assert.deepEqual(await fixture.operations(), ['selected-group-mentions'])
  } finally {
    await fixture.setAuthState('ready')
  }

  const enableRequestedAt = Date.now()
  await control.command('clickWhenEnabled', dingtalk('enable'))
  await control.command('waitFor', `${dingtalk('pause')}:enabled`)
  await control.command('waitFor', panel, { text: '已验证所选会话' })
  const active = (await load()).primary.dingtalkDelegation
  assert.equal(active.enabled, true)
  const boundary = Date.parse(active.enabledAfter)
  assert.ok(
    boundary >= enableRequestedAt && boundary <= Date.now(),
    'Activation sets the start time'
  )
  assert.deepEqual(active.sources, saved.sources)
  const operations = await fixture.operations()
  assert.ok(operations.slice(1).includes('selected-group-mentions'))
  assert.ok(operations.slice(1).includes('selected-direct-messages'))
  assert.ok(!operations.includes('login') && !operations.includes('send'))

  await control.command('clickWhenEnabled', dingtalk('pause'))
  await control.command('waitFor', `${dingtalk('enable')}:enabled`)
  const paused = (await load()).primary.dingtalkDelegation
  assert.equal(paused.enabled, false)
  assert.equal(paused.enabledAfter ?? null, null)
  assert.deepEqual(paused.sources, active.sources)
  assert.deepEqual(paused.templates, saved.templates)

  await control.command('clickWhenEnabled', dingtalk('switch-account'))
  await control.command('clickWhenEnabled', dingtalk('select-account-other-org:fixture-user'))
  await control.command('waitFor', dingtalk('account'), { text: 'Fixture · Other Organization' })
  await control.command('clickWhenEnabled', dingtalk('confirm-account'))
  await control.command('waitFor', `${dingtalk('save-scope')}:disabled`)
  const switched = (await load()).primary.dingtalkDelegation
  assert.equal(switched.account.accountId, saved.account.accountId)
  assert.equal(switched.account.organizationId, 'other-org')
  assert.equal(switched.enabled, false)
  assert.equal(switched.enabledAfter ?? null, null)
  assert.deepEqual(switched.sources, [])
  const finalOperations = await fixture.operations()
  assert.ok(!finalOperations.includes('login') && !finalOperations.includes('send'))
}
