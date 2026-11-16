import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'

const USER_ID = 9001
const selector = id => `[data-testid="${id}"]`

/** The real onboarding record persists independently of optional source configuration. */
export function createDesktopScenario({ uiTimeoutMs, captureScreenshot }) {
  return {
    verifiesStandInOnboarding: true,
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      await control.command('clickWhenEnabled', selector('personal-stand-in-button'))
      await control.command('waitFor', `${selector('stand-in-onboarding-skip')}:enabled`)
      const before = await rpc('runtime.stand_in.personal.get', { userId: USER_ID })
      await control.command('clickWhenEnabled', selector('stand-in-onboarding-skip'))
      await control.command('waitFor', selector('stand-in-onboarding'), { visible: false })
      await control.command('waitFor', selector('stand-in-conversation'), { visible: true })
      assert.equal(
        (await rpc('runtime.stand_in.onboarding.get', { userId: USER_ID })).state.completed,
        true
      )
      assert.deepEqual(
        await rpc('runtime.stand_in.personal.get', { userId: USER_ID }),
        before,
        'Skipping must not enable intake or save unconfirmed source settings'
      )
      await control.command('navigate', 'body', { value: '/' })
      await control.command('waitFor', selector('personal-stand-in-button'), { visible: true })
      await control.command('clickWhenEnabled', selector('personal-stand-in-button'))
      await control.command('waitFor', selector('stand-in-conversation'), { visible: true })
      assert.equal(await control.command('getElementCount', selector('stand-in-onboarding')), '0')
      await control.command('clickWhenEnabled', selector('stand-in-details-open'))
      await control.command('waitFor', selector('stand-in-details-work-sources'), {
        text: '尚未配置工作来源',
        visible: true,
      })
      await control.command('waitFor', selector('stand-in-im-channels'), {
        text: '从聊天工具联系助理',
        visible: true,
      })
      await captureScreenshot(control, 'stand-in-onboarding-skipped.png')
      await control.command('press', selector('stand-in-details-popover'), { key: 'Escape' })
    },
  }
}
