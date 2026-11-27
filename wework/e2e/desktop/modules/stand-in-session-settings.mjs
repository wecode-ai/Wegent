import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { openConnectionTypePicker } from './stand-in-flows.mjs'

/** Reuse the installed DingTalk protocol fixture and real renderer/settings persistence. */
export async function verifyStandInSessionSettings(control, uiTimeoutMs, roleId) {
  const id = 'stand-in-dingtalk-policy-connection-migration-fixture'
  const timing = `[data-testid="${id}"]`
  const strategy = `[data-testid="${id}-session-strategy"]`
  const setTiming = async immediate => {
    const mode = immediate ? 'immediate' : 'collect'
    await control.command('clickWhenEnabled', timing)
    await control.command('clickWhenEnabled', `[data-testid="${id}-${mode}"]`)
  }
  const load = () =>
    requestExecutor(control, 'runtime.stand_in.personal.get', { userId: 9001 }, uiTimeoutMs)
  await control.command('clickWhenEnabled', '[data-testid="stand-in-dingtalk-open-scope-group-connection-migration-fixture"]')
  await control.command(
    'waitFor',
    '[data-testid="stand-in-processing-settings-toggle"][aria-expanded="false"]'
  )
  await control.command('clickWhenEnabled', '[data-testid="stand-in-processing-settings-toggle"]')
  await control.command('waitFor', `${strategy}:disabled`)
  await setTiming(false)
  await control.command('waitFor', `${strategy}:enabled`)
  for (const immediate of [false, true]) {
    for (const sessionStrategy of ['reuse', 'independent']) {
      const timingLabel = immediate ? '触发即处理' : '后台排队'
      if ((await control.command('getText', timing)) !== timingLabel) await setTiming(immediate)
      const independent = sessionStrategy === 'independent'
      if (
        (await control.command('getAttribute', strategy, { value: 'aria-checked' })) !==
        String(independent)
      )
        await control.command('clickWhenEnabled', strategy)
      await control.command('clickWhenEnabled', '[data-testid="stand-in-save"]')
      // Saving a source returns to the open role settings.
      await control.command('waitFor', '[data-testid="stand-in-connections-open"]')
      await control.command('waitFor', '[data-testid="stand-in-saved"]')
      const saved = await load()
      const source = saved.roles
        .find(role => role.id === roleId)
        .connections.find(row => row.id === 'connection-migration-fixture')
      assert.deepEqual(
        { ...source.policy, sessionStrategy: source.policy.sessionStrategy ?? 'reuse' },
        {
          automatic: true,
          askBeforeAct: true,
          immediate,
          sessionStrategy,
        }
      )
      await control.command('clickWhenEnabled', '[data-testid="stand-in-connections-open"]')
      await openConnectionTypePicker(control)
      await control.command('clickWhenEnabled', '[data-testid="stand-in-add-dingtalk-connection"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-dingtalk-open-scope-group-connection-migration-fixture"]')
      await control.command(
        'waitFor',
        '[data-testid="stand-in-processing-settings-toggle"][aria-expanded="false"]'
      )
      await control.command(
        'clickWhenEnabled',
        '[data-testid="stand-in-processing-settings-toggle"]'
      )
      await control.command('waitFor', timing, { text: timingLabel })
      assert.equal(
        await control.command('getAttribute', strategy, { value: 'aria-checked' }),
        String(independent)
      )
      await control.command('waitFor', `${strategy}[aria-checked="${independent}"]`)
    }
  }
}
