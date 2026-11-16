import assert from 'node:assert/strict'
import { openStandInDetails } from './stand-in-profile-navigation.mjs'

/** Clone only the isolated scenario's schedule; never run this disabled hourly fixture. */
export async function verifyStandInScheduleActivity(control, rpc, schedule, captureScreenshot) {
  const id = `${schedule.id}-hourly-profile`
  const row = `[data-testid="stand-in-details-schedule-${id}"]`
  const dialog = '[data-testid="stand-in-schedule-dialog"]'
  const waitForTriggerFocus = async () => {
    try {
      await control.command('waitFor', `${row}:focus`)
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
    await openStandInDetails(control)
    await control.command('clickWhenEnabled', row)
    await control.command('waitFor', dialog)
    assert.equal(
      await control.command('getAttribute', '[data-testid="stand-in-details-popover"]', {
        value: 'aria-hidden',
      }),
      'true'
    )
    await control.command('waitFor', '[data-testid="automation-custom-frequency-menu"]', {
      text: '每小时',
    })
    assert.equal(
      await control.command('getValue', '[data-testid="automation-custom-interval"]'),
      '1'
    )
    assert.equal(
      await control.command(
        'getElementCount',
        `${dialog} [data-testid="automation-detail-close-button"]`
      ),
      '0'
    )
    await captureScreenshot(control, 'schedule-activity-centered-editor.png')
    await control.command('fill', '[data-testid="automation-name-input"]', {
      value: '尚未保存的名字',
    })
    await control.command('click', '[data-testid="stand-in-schedule-dialog-close"]')
    await control.command('click', '[data-testid="automation-keep-editing"]')
    assert.equal(
      await control.command('getValue', '[data-testid="automation-name-input"]'),
      '尚未保存的名字'
    )
    await control.command('click', '[data-testid="stand-in-schedule-dialog-close"]')
    await control.command('click', '[data-testid="automation-discard"]')
    await control.command('waitFor', dialog, { visible: false })
    await waitForTriggerFocus()
    await control.command('click', row)
    await control.command('fill', '[data-testid="automation-name-input"]', {
      value: '仅改名，不改频率',
    })
    await control.command('clickWhenEnabled', '[data-testid="automation-save-button"]')
    await control.command('waitFor', dialog, { visible: false })
    await waitForTriggerFocus()
    const saved = (await rpc('runtime.automations.list', {})).items.find(item => item.id === id)
    assert.equal(saved.name, '仅改名，不改频率')
    assert.equal(saved.enabled, false)
    assert.deepEqual(saved.schedule, { type: 'cron', expression: '0 * * * *' })
    await captureScreenshot(control, 'schedule-activity-restored-focus.png')
    await control.command('click', '[data-testid="stand-in-details-open"]')
  } finally {
    await rpc('runtime.automations.delete', { automationId: id })
  }
}
