import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { openStandInSettings } from './stand-in-profile-navigation.mjs'
import { openConnectionTypePicker } from './stand-in-flows.mjs'

/** Extend the connections checkpoint using its real persisted, account-bound group. */
export async function verifyStandInGroupMessageScope(control, uiTimeoutMs, roleId) {
  const groupId = 'connection-migration-fixture'
  const selector = `[data-testid="stand-in-dingtalk-message-scope-${groupId}"]`
  const load = async () => {
    const settings = await requestExecutor(
      control,
      'runtime.stand_in.personal.get',
      { userId: 9001 },
      uiTimeoutMs
    )
    return settings.roles.find(role => role.id === roleId)
  }
  const open = async () => {
    await openStandInSettings(control)
    await control.command('clickWhenEnabled', '[data-testid="stand-in-connections-open"]')
    await openConnectionTypePicker(control)
    await control.command('clickWhenEnabled', '[data-testid="stand-in-add-dingtalk-connection"]')
    await control.command('waitFor', selector)
  }
  const original = (await load()).connections.find(row => row.id === groupId)
  assert.ok(original)
  for (const mode of ['all-messages', 'mentions']) {
    await control.command('select', selector, { value: mode })
    await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
    await control.command('waitFor', '[data-testid="stand-in-page"]', { visible: false })
    const saved = (await load()).connections.find(row => row.id === groupId)
    assert.equal(saved.collectionKey, mode === 'all-messages' ? mode : undefined)
    assert.equal(saved.profile, original.profile)
    assert.deepEqual(saved.policy, original.policy)
    await open()
    assert.equal(await control.command('getValue', selector), mode)
  }
  await control.command('select', selector, { value: 'all-messages' })
  await control.command('clickWhenEnabled', '[data-testid="stand-in-cancel"]')
  await control.command('clickWhenEnabled', '[data-testid="stand-in-discard"]')
  await control.command('waitFor', '[data-testid="stand-in-page"]', { visible: false })
  await open()
  assert.equal(await control.command('getValue', selector), 'mentions')
}
