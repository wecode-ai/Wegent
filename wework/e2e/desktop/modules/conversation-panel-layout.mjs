import { ACTIVE_WORKBENCH_SELECTOR, assert } from './shared.mjs'

// Exercise the pinned-summary branch that used to crush text while chat width animated.
export async function verifyConversationPanelLayout(control) {
  const selector = testId => `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="${testId}"]`
  const previousSize = JSON.parse(
    await control.command('setMainWindowSize', 'body', {
      value: JSON.stringify({ width: 1600, height: 1200 }),
    })
  )
  const toggle = selector('toggle-right-workspace-panel-button')
  const shell = selector('right-workspace-panel-shell')
  const spacer = selector('environment-info-panel-spacer')
  const frame = selector('desktop-workbench-scroll-frame')
  const environment = selector('environment-info-button')
  let wasPinned
  try {
    await control.command('waitFor', `${shell}[aria-hidden="true"]`)
    await control.command(
      'waitFor',
      `${selector('environment-info-panel-container')}[data-docked="true"]`
    )
    wasPinned = await control.command('getAttribute', environment, { value: 'aria-expanded' })
    if (wasPinned !== 'true') await control.command('click', environment)
    await control.command(
      'waitFor',
      `${selector('environment-info-panel-container')}[class~="w-[320px]"]`
    )
    assert.equal(await control.command('getStyle', spacer, { value: 'width' }), '320px')
    for (const target of [frame, spacer]) {
      assert.equal(
        await control.command('getStyle', target, { value: 'transition-property' }),
        'none',
        'Conversation geometry must commit without intermediate animated widths'
      )
    }
    await control.command('click', toggle)
    await control.command('waitFor', `${shell}[aria-hidden="false"]`)
    assert.equal(await control.command('getStyle', spacer, { value: 'width' }), '0px')
    assert.equal(await control.command('getStyle', frame, { value: 'transition-property' }), 'none')
    await control.command('click', toggle)
    await control.command('waitFor', `${shell}[aria-hidden="true"]`)
    assert.equal(await control.command('getStyle', spacer, { value: 'width' }), '320px')
    assert.equal(await control.command('getStyle', frame, { value: 'transition-property' }), 'none')
  } finally {
    if ((await control.command('getAttribute', shell, { value: 'aria-hidden' })) === 'false') {
      await control.command('click', toggle)
    }
    if (wasPinned === 'false') await control.command('click', environment)
    await control.command('setMainWindowSize', 'body', { value: JSON.stringify(previousSize) })
  }
}
