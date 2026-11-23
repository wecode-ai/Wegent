import assert from 'node:assert/strict'
import { until } from './plugin-regression-fixture.mjs'
import { openStandInSettings } from './stand-in-profile-navigation.mjs'
import { openConnectionTypePicker } from './stand-in-flows.mjs'

/** Clone only the isolated scenario's schedule; never run this disabled hourly fixture. */
export async function verifyStandInScheduleActivity(control, rpc, schedule, captureScreenshot) {
  const id = `${schedule.id}-hourly-profile`
  const rowId = `automation-open-${id}`
  const row = `[data-testid="${rowId}"]`
  const editor = '[data-testid="automation-detail-panel"]'
  const waitForTriggerFocus = async () => {
    try {
      // The editor restores document focus even if the native window is in the background.
      await until(
        () => control.command('getActiveElementTestId', 'body'),
        active => active === rowId,
        `The schedule editor did not restore focus to ${rowId}`,
        5_000
      )
    } catch (error) {
      console.error('[stand-in-schedule-focus]', {
        activeElement: await control.command('getActiveElementTestId', 'body'),
        window: await control.command('getWindowFocusSnapshot', 'body'),
      })
      throw error
    }
  }
  await rpc('runtime.automations.create', {
    automation: {
      ...schedule,
      id,
      name: '每小时检查发布（验证）',
      enabled: false,
      schedule: { type: 'cron', expression: '0 * * * *' },
      nextRunAt: null,
    },
  })
  try {
    await control.command('clickWhenEnabled', '[data-testid="personal-stand-in-button"]')
    await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-open"]')
    await openStandInSettings(control)
    await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-connections-open"]')
    await openConnectionTypePicker(control)
    await control.command('clickWhenEnabled', '[data-testid="stand-in-time-connections"]')
    await control.command('clickWhenEnabled', row)
    await control.command('waitFor', editor)
    await control.command('waitFor', '[data-testid="stand-in-calendar-connection"]')
    assert.equal(
      await control.command('getElementCount', '[data-testid="stand-in-details-popover"]'),
      '0'
    )
    await control.command('waitFor', '[data-testid="automation-custom-frequency-menu"]', {
      text: '每小时',
    })
    assert.equal(
      await control.command('getValue', '[data-testid="automation-custom-interval"]'),
      '1'
    )
    assert.equal(
      await control.command('getElementCount', `${editor} [data-testid="automation-detail-close"]`),
      '1'
    )
    await captureScreenshot(control, 'schedule-calendar-editor.png')
    await control.command('fill', '[data-testid="automation-name-input"]', {
      value: '尚未保存的名字',
    })
    await control.command('click', '[data-testid="automation-detail-close"]')
    await control.command('click', '[data-testid="automation-keep-editing"]')
    assert.equal(
      await control.command('getValue', '[data-testid="automation-name-input"]'),
      '尚未保存的名字'
    )
    await control.command('click', '[data-testid="automation-detail-close"]')
    await control.command('click', '[data-testid="automation-discard"]')
    await control.command('waitFor', editor, { visible: false })
    await waitForTriggerFocus()
    await control.command('click', row)
    await control.command('waitFor', `${editor} [data-testid="automation-name-input"]`, {
      visible: true,
    })
    await control.command('fill', '[data-testid="automation-name-input"]', {
      value: '仅改名，不改频率',
    })
    await control.command('clickWhenEnabled', '[data-testid="automation-save-button"]')
    await control.command('waitFor', editor, { visible: false })
    await waitForTriggerFocus()
    const saved = (await rpc('runtime.automations.list', {})).items.find(item => item.id === id)
    assert.equal(saved.name, '仅改名，不改频率')
    assert.equal(saved.enabled, false)
    assert.deepEqual(saved.schedule, { type: 'cron', expression: '0 * * * *' })
    await captureScreenshot(control, 'schedule-calendar-restored-focus.png')
    await control.command('click', '[data-testid="stand-in-primary-profile-close"]')
  } finally {
    await rpc('runtime.automations.delete', { automationId: id })
  }
}
