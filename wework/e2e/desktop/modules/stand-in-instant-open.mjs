import assert from 'node:assert/strict'
import { openStandInSettings } from './stand-in-profile-navigation.mjs'
import { until } from './plugin-regression-fixture.mjs'

/** A returning user can use their loaded stand-in immediately after navigation. */
export async function verifyStandInInstantReturn(control) {
  const workspace = '[data-testid="personal-stand-in-workspace"]'
  const primary = `${workspace} [data-testid="stand-in-primary-open"]`
  const composer = `${workspace} [data-testid="stand-in-conversation"] [data-testid="chat-message-input"]`
  const settingsButtonId = 'stand-in-details-open'
  await control.command('waitFor', `${primary}[aria-current="page"]`)
  await openStandInSettings(control)
  await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-connections-open"]')
  await control.command('waitFor', '[data-testid="stand-in-connection-settings"]')
  await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-profile-close"]')
  await control.command('waitFor', '[data-testid="stand-in-profile-panel"]', { visible: false })
  // An inactive Electron window can retain the active element without matching :focus.
  await until(
    () => control.command('getActiveElementTestId', 'body'),
    active => active === settingsButtonId,
    'Closing stand-in settings must return focus to the assistant details button'
  )
  await control.command('waitFor', composer)
  await control.command('clickWhenEnabled', '[data-testid="new-chat-button"]')
  await control.command('waitFor', workspace, { visible: false })
  // Assert readiness in the next browser macrotask, not after a data-loading wait.
  await control.command('clickThenMacrotask', '[data-testid="personal-stand-in-button"]', {
    target: composer,
  })
  assert.equal(
    await control.command(
      'getElementCount',
      `${workspace} [data-testid="stand-in-overview"] > main > [role="status"]`
    ),
    '0',
    'Returning must retain settings and the ready conversation, not show another loading screen'
  )
  assert.equal(
    await control.command('getElementCount', `${workspace} > [role="status"]`),
    '0',
    'Returning must not replace the workspace with binding discovery'
  )
  assert.equal(
    await control.command('getElementCount', `${workspace} > [role="alert"]`),
    '0',
    'Returning to the same account must not report an ownership error'
  )
  await control.command('waitFor', `${primary}[aria-current="page"]`)
}
