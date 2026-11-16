import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { waitForElementWidth } from '../modules/layout-metrics.mjs'

const USER_ID = 9001
const selector = id => `[data-testid="${id}"]`

async function verifyNarrowImMenu(control) {
  const previous = await control.command('setMainWindowSize', 'body', {
    value: JSON.stringify({ width: 760, height: 760 }),
  })
  try {
    await waitForElementWidth(
      control,
      'body',
      width => width > 0 && width <= 767,
      'IM menu narrow viewport'
    )
    await control.command('clickWhenEnabled', selector('stand-in-im-add-channels'))
    for (const channel of ['dingtalk', 'telegram', 'discord', 'weibo']) {
      const item = `[role="menuitem"]${selector('stand-in-im-channel-' + channel)}`
      await control.command('waitFor', item, { visible: true })
      const boxes = JSON.parse(await control.command('getElementMetrics', item))
      assert.equal(boxes.length, 1)
      assert.ok(
        boxes[0].width >= 44 && boxes[0].height >= 44,
        `Narrow ${channel} menu target: ${JSON.stringify(boxes)}`
      )
    }
    await control.command('clickWhenEnabled', selector('stand-in-im-add-channels'))
    await control.command(
      'waitFor',
      `[role="menuitem"]${selector('stand-in-im-channel-dingtalk')}`,
      { visible: false }
    )
  } finally {
    await control.command('setMainWindowSize', 'body', { value: previous })
  }
}

/** The real onboarding record persists independently of optional source configuration. */
export function createDesktopScenario({ uiTimeoutMs, captureScreenshot }) {
  return {
    verifiesStandInOnboarding: true,
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      await control.command('clickWhenEnabled', selector('personal-stand-in-button'))
      await control.command('waitFor', `${selector('stand-in-onboarding-skip')}:enabled`)
      const before = await rpc('runtime.stand_in.personal.get', { userId: USER_ID })
      await control.command('clickWhenEnabled', selector('stand-in-add-projects-connection'))
      await control.command('clickWhenEnabled', selector('stand-in-source-collaboration'))
      await control.command('clickWhenEnabled', selector('stand-in-onboarding-skip'))
      await control.command('clickWhenEnabled', selector('stand-in-onboarding-keep-editing'))
      assert.equal(
        await control.command('getAttribute', selector('stand-in-source-collaboration'), {
          value: 'aria-checked',
        }),
        'true'
      )
      await control.command('clickWhenEnabled', selector('stand-in-onboarding-skip'))
      await control.command('clickWhenEnabled', selector('stand-in-onboarding-discard'))
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
      await verifyNarrowImMenu(control)
      await control.command('clickWhenEnabled', selector('stand-in-details-work-sources'))
      await control.command('waitFor', selector('stand-in-primary-profile'), { visible: true })
      await control.command('press', selector('stand-in-preferences'), { key: 'Escape' })
      await control.command('waitFor', selector('stand-in-profile-panel'), { visible: false })
      assert.equal(await control.command('getActiveElementTestId', 'body'), 'stand-in-details-open')
      await control.command('clickWhenEnabled', selector('stand-in-details-open'))
      await control.command('clickWhenEnabled', selector('stand-in-details-work-sources'))
      await control.command('clickWhenEnabled', selector('stand-in-primary-connections-open'))
      await control.command('waitFor', selector('stand-in-connection-configured-filter'), {
        text: '已配置 0',
        visible: true,
      })
      await control.command('clickWhenEnabled', selector('stand-in-add-projects-connection'))
      await control.command('waitFor', selector('stand-in-processing-settings-toggle'), {
        text: '配置',
        visible: true,
      })
      await control.command('nativePress', selector('stand-in-processing-settings-toggle'), {
        key: 'Enter',
      })
      await control.command('waitFor', selector('stand-in-project-default-policy'), {
        visible: true,
      })
      assert.deepEqual(
        await rpc('runtime.stand_in.personal.get', { userId: USER_ID }),
        before,
        'Inspecting processing settings must not change the saved policy'
      )
      await captureScreenshot(control, 'stand-in-processing-disclosure.png')
      await control.command('clickWhenEnabled', selector('stand-in-source-collaboration'))
      await control.command('clickWhenEnabled', selector('stand-in-source-tags-toggle'))
      const tagInput = selector('stand-in-connection-tags-input')
      const invalidTag = 'Unfinished tag '.repeat(4).trim()
      await control.command('fill', tagInput, { value: invalidTag })
      await control.command('waitFor', '#stand-in-connection-tags-error', { visible: true })
      await control.command('waitFor', `${selector('stand-in-primary-save')}:disabled`)
      await control.command('clickWhenEnabled', selector('stand-in-primary-profile-close'))
      await control.command('waitFor', selector('stand-in-project-tags-keep-editing'), {
        visible: true,
      })
      await control.command('clickWhenEnabled', selector('stand-in-project-tags-keep-editing'))
      assert.equal(await control.command('getValue', tagInput), invalidTag)
      await captureScreenshot(control, 'stand-in-tag-draft-protected.png')
      await control.command('fill', tagInput, { value: '' })
      await control.command('waitFor', `${selector('stand-in-primary-save')}:enabled`)
      await control.command('fill', tagInput, { value: invalidTag })
      await control.command('clickWhenEnabled', selector('stand-in-primary-profile-close'))
      await control.command('clickWhenEnabled', selector('stand-in-project-tags-discard'))
      await control.command('waitFor', selector('stand-in-profile-panel'), { visible: false })
      assert.deepEqual(await rpc('runtime.stand_in.personal.get', { userId: USER_ID }), before)
      await control.command('clickWhenEnabled', selector('stand-in-create-role'))
      await control.command('fill', selector('stand-in-role-name'), {
        value: 'UI draft review role',
      })
      await control.command('clickWhenEnabled', selector('stand-in-connections-open'))
      await control.command('clickWhenEnabled', selector('stand-in-add-projects-connection'))
      await control.command('clickWhenEnabled', selector('stand-in-source-collaboration'))
      await control.command('clickWhenEnabled', selector('stand-in-connections-back'))
      await control.command('clickWhenEnabled', selector('stand-in-back'))
      await control.command('waitFor', selector('stand-in-source-summary'), {
        text: '协作项目',
        visible: true,
      })
      await captureScreenshot(control, 'stand-in-role-source-draft-retained.png')
      await control.command('clickWhenEnabled', selector('stand-in-connections-open'))
      await control.command('clickWhenEnabled', selector('stand-in-add-projects-connection'))
      assert.equal(
        await control.command('getAttribute', selector('stand-in-source-collaboration'), {
          value: 'aria-checked',
        }),
        'true'
      )
      await control.command('clickWhenEnabled', selector('stand-in-cancel'))
      await control.command('clickWhenEnabled', selector('stand-in-discard'))
      await control.command('waitFor', selector('stand-in-profile-panel'), { visible: false })
      assert.equal(await control.command('getActiveElementTestId', 'body'), 'stand-in-create-role')
      assert.deepEqual(await rpc('runtime.stand_in.personal.get', { userId: USER_ID }), before)
    },
  }
}
