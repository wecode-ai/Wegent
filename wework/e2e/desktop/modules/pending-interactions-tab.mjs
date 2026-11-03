import assert from 'node:assert/strict'

const TAB = '[data-testid="workspace-tab-select-pending-interactions"]'

export async function verifyPendingInteractionsTab(control, count, { openFromMenu = false } = {}) {
  const title = `待你处理（${count}）`
  await control.command('waitFor', TAB, { text: title })
  assert.equal(await control.command('getAttribute', TAB, { value: 'title' }), title)
  assert.equal(Number(await control.command('getElementCount', TAB)), 1)
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        '[data-testid="workspace-tab-close-pending-interactions"]'
      )
    ),
    0,
    'The default pending-interactions tab must remain fixed'
  )
  if (!openFromMenu) return
  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('waitFor', '[data-testid="workspace-tab-add-pending-interactions"]', {
    text: '待你处理',
  })
  await control.command('click', '[data-testid="workspace-tab-add-pending-interactions"]')
  assert.equal(await control.command('getAttribute', TAB, { value: 'aria-selected' }), 'true')
  assert.equal(Number(await control.command('getElementCount', TAB)), 1)
  assert.equal(
    Number(await control.command('getElementCount', '[data-testid="workspace-tab-add-menu"]')),
    0
  )
}
