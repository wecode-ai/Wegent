import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { openConnectionTypePicker } from './stand-in-flows.mjs'

/** Reuse the installed DingTalk protocol fixture and real renderer/settings persistence. */
export async function verifyStandInSessionSettings(control, uiTimeoutMs) {
  const id = 'stand-in-dingtalk-policy-connection-migration-fixture'
  const timing = `[data-testid="${id}"]`
  const strategy = `[data-testid="${id}-session-strategy"]`
  const load = () =>
    requestExecutor(control, 'runtime.stand_in.personal.get', { userId: 9001 }, uiTimeoutMs)
  await control.command(
    'waitFor',
    '[data-testid="stand-in-processing-settings-toggle"][aria-expanded="false"]'
  )
  await control.command('clickWhenEnabled', '[data-testid="stand-in-processing-settings-toggle"]')
  await control.command('waitFor', `${strategy}:disabled`)
  await control.command('clickWhenEnabled', `[data-testid="${id}-enable"]`)
  await control.command('waitFor', `${strategy}:enabled`)
  for (const immediate of [false, true]) {
    for (const sessionStrategy of ['reuse', 'independent']) {
      if (
        (await control.command('getAttribute', timing, { value: 'aria-checked' })) !==
        String(immediate)
      )
        await control.command('clickWhenEnabled', timing)
      const independent = sessionStrategy === 'independent'
      if (
        (await control.command('getAttribute', strategy, { value: 'aria-checked' })) !==
        String(independent)
      )
        await control.command('clickWhenEnabled', strategy)
      await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-save"]')
      await control.command('waitFor', '[data-testid="stand-in-primary-profile"]', {
        visible: false,
      })
      const saved = await load()
      const source = saved.primary.connections.find(
        row => row.id === 'connection-migration-fixture'
      )
      assert.deepEqual(source.policy, {
        automatic: true,
        askBeforeAct: true,
        immediate,
        sessionStrategy,
      })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-settings-open"]')
      await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-connections-open"]')
      await openConnectionTypePicker(control)
      await control.command('clickWhenEnabled', '[data-testid="stand-in-add-dingtalk-connection"]')
      await control.command(
        'waitFor',
        '[data-testid="stand-in-processing-settings-toggle"][aria-expanded="false"]'
      )
      await control.command(
        'clickWhenEnabled',
        '[data-testid="stand-in-processing-settings-toggle"]'
      )
      await control.command('waitFor', `${timing}[aria-checked="${immediate}"]`)
      assert.equal(
        await control.command('getAttribute', strategy, { value: 'aria-checked' }),
        String(independent)
      )
      await control.command('waitFor', `${strategy}[aria-checked="${independent}"]`)
    }
  }
}
