import assert from 'node:assert/strict'

/** Check the real empty-state form before the existing successful Group creation. */
export async function verifyStandaloneGroupFormCancellation(control, content, uiTimeoutMs) {
  const name = '[data-testid="create-group-name"]'
  const submit = '[data-testid="create-group-submit"]'
  for (const value of ['', '   ']) {
    await control.command('fill', name, { value })
    await control.command('waitFor', `${submit}[disabled]`, {
      visible: true,
      timeoutMs: uiTimeoutMs,
    })
  }
  await control.command('fill', name, { value: '取消创建的群' })
  await control.command('waitFor', `${submit}:not([disabled])`, {
    visible: true,
    timeoutMs: uiTimeoutMs,
  })
  await control.command('click', '[data-testid="create-group-cancel"]')
  await control.command('waitFor', '[data-testid="create-group-dialog"]', {
    visible: false,
    timeoutMs: uiTimeoutMs,
  })
  await control.command('waitFor', `${content} [data-testid="group-empty-create"]`, {
    visible: true,
    timeoutMs: uiTimeoutMs,
  })
  assert.equal(
    Number(await control.command('getElementCount', `${content} [data-testid^="group-nav-"]`)),
    0,
    'Cancelling Group creation must leave the first-use group catalog empty'
  )
  await control.command('click', `${content} [data-testid="group-create-open"]`)
  await control.command('waitFor', name, { visible: true, timeoutMs: uiTimeoutMs })
  assert.equal(await control.command('getValue', name), '')
}
