import assert from 'node:assert/strict'

/** A returning user can use their loaded stand-in immediately after navigation. */
export async function verifyStandInInstantReturn(control) {
  const workspace = '[data-testid="personal-stand-in-workspace"]'
  await control.command('clickWhenEnabled', '[data-testid="runtime-task-view-menu-button"]')
  await control.command('clickWhenEnabled', '[data-testid="runtime-task-view-board"]')
  await control.command('waitFor', workspace, { visible: false })
  // Assert readiness in the next browser macrotask, not after a data-loading wait.
  await control.command('clickThenMacrotask', '[data-testid="personal-stand-in-button"]', {
    target: `${workspace} [data-testid="stand-in-primary-open"]`,
  })
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
  await control.command(
    'waitFor',
    `${workspace} [data-testid="stand-in-primary-open"][aria-current="page"]`
  )
}
