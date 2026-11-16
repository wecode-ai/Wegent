import assert from 'node:assert/strict'

/** A returning user can use their loaded stand-in immediately after navigation. */
export async function verifyStandInInstantReturn(control) {
  const workspace = '[data-testid="personal-stand-in-workspace"]'
  const composer = `${workspace} [data-testid="stand-in-conversation"] [data-testid="chat-message-input"]`
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
  await control.command(
    'waitFor',
    `${workspace} [data-testid="stand-in-primary-open"][aria-current="page"]`
  )
}
