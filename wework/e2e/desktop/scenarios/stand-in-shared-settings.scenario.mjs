import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { openStandInSettings } from '../modules/stand-in-profile-navigation.mjs'

const USER = 9001
const testId = id => `[data-testid=${JSON.stringify(id)}]`
const panel = testId('stand-in-profile-panel')

export function createDesktopScenario({ uiTimeoutMs, captureScreenshot }) {
  return {
    async verify(control) {
      const readSettings = () =>
        requestExecutor(control, 'runtime.stand_in.personal.get', { userId: USER }, uiTimeoutMs)
      const click = id => control.command('clickWhenEnabled', testId(id), { timeoutMs: 5_000 })
      const wait = (selector, options = {}) =>
        control.command('waitFor', selector, { timeoutMs: 5_000, ...options })
      const initial = await readSettings()
      if (!initial.primary) {
        const primary = { enabled: true, prompt: '跟进工作进展', preferences: '' }
        await requestExecutor(
          control,
          'runtime.stand_in.personal.save',
          { userId: USER, settings: { ...initial, primary } },
          uiTimeoutMs
        )
      }
      const baseline = await readSettings()
      const roleId = baseline.roles[0]?.id
      assert.ok(roleId, 'The settings fixture must have a scenario role')
      await click('workspace-tab-select-fixed-task')
      await click('personal-stand-in-button')
      await click('stand-in-primary-open')
      await openStandInSettings(control)
      await wait(`${panel} header h2`, { text: '设置', visible: true })
      await wait(testId('stand-in-primary-execution-toggle'), { text: '运行环境' })
      await wait(testId('stand-in-im-channels-toggle'))
      await wait(testId('stand-in-memory-open'))
      await click('stand-in-primary-profile-close')
      await wait(panel, { visible: false })

      const openRole = async () => {
        await click(`stand-in-overview-role-${roleId}`)
        await openStandInSettings(control)
        await wait(`${panel} header h2`, { text: '设置', visible: true })
        await wait(testId('stand-in-role-name'))
      }
      await openRole()
      await wait(testId('stand-in-connections-open'), { text: '连接' })
      await wait(testId('stand-in-advanced-open'), { text: '运行环境' })
      await wait(testId('stand-in-role-device'))
      await wait(testId('stand-in-im-channels-toggle'))
      await wait(testId('stand-in-memory-open'))
      await wait(`${panel} footer ${testId('stand-in-role-delete')}`, { visible: true })
      assert.equal(await control.command('getElementCount', `${panel} header button`), '2')
      await captureScreenshot(control, 'stand-in-scenario-role-settings.png', panel)

      const name = '项目进度助理'
      const prompt = '汇总每个项目的进展和待办'
      await control.command('fill', testId('stand-in-role-name'), { value: name })
      await control.command('fill', testId('stand-in-prompt'), { value: prompt })
      await click('stand-in-advanced-open')
      await wait(testId('stand-in-path-advanced'), { text: '运行环境' })
      await wait(testId('stand-in-workspace-bar'))
      await click('stand-in-back')
      await wait(testId('stand-in-prompt'))
      assert.equal(await control.command('getValue', testId('stand-in-prompt')), prompt)
      await click('stand-in-save')
      await wait(panel, { visible: false })

      const saved = await readSettings()
      const role = saved.roles.find(item => item.id === roleId)
      assert.equal(role?.name, name)
      assert.equal(role?.prompt, prompt)
      assert.deepEqual(saved.primary, baseline.primary)
      await openRole()
      assert.equal(await control.command('getValue', testId('stand-in-role-name')), name)
      assert.equal(await control.command('getValue', testId('stand-in-prompt')), prompt)
      await click('stand-in-close')
      await wait(panel, { visible: false })
    },
  }
}
