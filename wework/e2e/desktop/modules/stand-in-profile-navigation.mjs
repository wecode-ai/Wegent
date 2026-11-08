import assert from 'node:assert/strict'

export async function openStandInDetails(control) {
  if (
    (await control.command('getElementCount', '[data-testid="stand-in-details-popover"]')) === '0'
  )
    await control.command('clickWhenEnabled', '[data-testid="stand-in-details-open"]')
  await control.command('waitFor', '[data-testid="stand-in-details-popover"]')
}

export async function openStandInMemory(control) {
  if ((await control.command('getElementCount', '[data-testid="stand-in-memory-open"]')) === '0')
    await openStandInSettings(control)
  await control.command('clickWhenEnabled', '[data-testid="stand-in-memory-open"]')
  await control.command('waitFor', '[data-testid="stand-in-memory-panel"]')
}

export async function openStandInActivity(control) {
  if ((await control.command('getElementCount', '[data-testid="stand-in-work-dialog"]')) !== '0')
    return
  await openStandInDetails(control)
  await control.command('clickWhenEnabled', '[data-testid="stand-in-role-chat"]')
}

export async function openStandInExamples(control) {
  await openStandInDetails(control)
  await control.command('clickWhenEnabled', '[data-testid="stand-in-guide-open"]')
}

export async function verifyReadOnlyWorkActivity(control, taskId, captureScreenshot) {
  await openStandInDetails(control)
  const row = `[data-testid="stand-in-details-task-${taskId}"]`
  await control.command('clickWhenEnabled', row)
  const preview = '[data-testid="stand-in-details-activity"]'
  await control.command('waitFor', preview)
  assert.equal(
    await control.command('getElementCount', `${preview} [data-testid="chat-message-input"]`),
    '0'
  )
  await control.command('waitFor', '[data-testid="stand-in-details-open-task"]', {
    text: '在工作区打开对话',
  })
  await captureScreenshot(control, 'activity-readonly-preview.png')
  await control.command('click', '[data-testid="stand-in-details-back"]')
  await control.command('waitFor', `${row}:focus`)
  await control.command('click', '[data-testid="stand-in-details-open"]')
}

export async function openStandInSettings(control) {
  await openStandInDetails(control)
  await control.command('clickWhenEnabled', '[data-testid="stand-in-settings-open"]')
  await control.command('waitFor', '[data-testid="stand-in-profile-panel"]')
}

/** Exercise the real shared header, memory discard guard and source hierarchy. */
export async function verifyStandInProfileNavigation(control, captureScreenshot) {
  const absent = async selector =>
    assert.equal(await control.command('getElementCount', selector), '0')
  const panel = '[data-testid="stand-in-profile-panel"]'
  await openStandInDetails(control)
  await control.command('waitFor', '[data-testid="stand-in-guide-open"]')
  await absent('[data-testid="stand-in-details-identity"] img')
  await control.command('clickWhenEnabled', '[data-testid="stand-in-settings-open"]')
  await control.command('waitFor', '[data-testid="stand-in-primary-profile"]')
  for (const id of ['stand-in-primary-enabled', 'stand-in-guide-open', 'stand-in-role-chat'])
    await absent(`${panel} [data-testid="${id}"]`)
  await control.command('waitFor', '[data-testid="stand-in-memory-open"]')
  await captureScreenshot(control, 'stand-in-primary-single-lifecycle-control.png', panel)
  await control.command('click', '[data-testid="stand-in-memory-open"]')
  await control.command('waitFor', '[data-testid="stand-in-memory-back"]')
  await absent(`${panel} h2`)
  await control.command('click', '[data-testid="stand-in-memory-add"]')
  await control.command('fill', '[data-testid="stand-in-memory-content"]', {
    value: 'Discard this verification draft',
  })
  await control.command('click', '[data-testid="stand-in-memory-back"]')
  await control.command('waitFor', '[data-testid="stand-in-memory-discard"]')
  await control.command('click', '[data-testid="stand-in-memory-keep"]')
  assert.equal(
    await control.command('getValue', '[data-testid="stand-in-memory-content"]'),
    'Discard this verification draft'
  )
  await control.command('click', '[data-testid="stand-in-memory-path-settings"]')
  await control.command('click', '[data-testid="stand-in-memory-discard"]')
  await control.command('waitFor', '[data-testid="stand-in-primary-connections-open"]')
  await control.command('click', '[data-testid="stand-in-primary-connections-open"]')
  await control.command('waitFor', '[data-testid="stand-in-settings-path"]')
  await absent(`${panel} h2`)
  await control.command('click', '[data-testid="stand-in-primary-back-to-settings"]')
  await control.command('click', '[data-testid="stand-in-primary-profile-close"]')
  await control.command('waitFor', panel, { visible: false })
}
