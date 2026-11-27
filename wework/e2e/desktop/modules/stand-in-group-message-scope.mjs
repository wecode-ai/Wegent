import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { openStandInSettings } from './stand-in-profile-navigation.mjs'
import { openConnectionTypePicker } from './stand-in-flows.mjs'

/** Extend the connections checkpoint using its real persisted, account-bound group. */
export async function verifyStandInGroupMessageScope(control, uiTimeoutMs, roleId) {
  const groupId = 'connection-migration-fixture'
  const id = `stand-in-dingtalk-message-scope-${groupId}`
  const selector = `[data-testid="${id}"]`
  const choose = async mode => {
    await control.command('clickWhenEnabled', selector)
    await control.command('clickWhenEnabled', `[data-testid="${id}-${mode}"]`)
  }
  const load = async () => {
    const settings = await requestExecutor(
      control,
      'runtime.stand_in.personal.get',
      { userId: 9001 },
      uiTimeoutMs
    )
    return settings.roles.find(role => role.id === roleId)
  }
  const openSource = async () => {
    await control.command('clickWhenEnabled', '[data-testid="stand-in-connections-open"]')
    await openConnectionTypePicker(control)
    await control.command('clickWhenEnabled', '[data-testid="stand-in-add-dingtalk-connection"]')
    await control.command('clickWhenEnabled', '[data-testid="stand-in-dingtalk-open-scope-group-connection-migration-fixture"]')
    await control.command('waitFor', selector)
  }
  const original = (await load()).connections.find(row => row.id === groupId)
  assert.ok(original)
  for (const mode of ['all-messages', 'mentions']) {
    await choose(mode)
    await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
    await control.command('waitFor', '[data-testid="stand-in-connections-open"]')
    await control.command('waitFor', '[data-testid="stand-in-saved"]')
    const saved = (await load()).connections.find(row => row.id === groupId)
    assert.equal(saved.collectionKey, mode === 'all-messages' ? mode : undefined)
    assert.equal(saved.profile, original.profile)
    assert.deepEqual(saved.policy, original.policy)
    await openSource()
    await control.command('waitFor', selector, {
      text: mode === 'all-messages' ? '每条新消息' : '仅接收 @我',
    })
  }
  await choose('all-messages')
  await control.command('clickWhenEnabled', '[data-testid="stand-in-cancel"]')
  await control.command('clickWhenEnabled', '[data-testid="stand-in-discard"]')
  await control.command('waitFor', '[data-testid="stand-in-page"]', { visible: false })
  await openStandInSettings(control)
  await openSource()
  await control.command('waitFor', selector, { text: '仅接收 @我' })
}
