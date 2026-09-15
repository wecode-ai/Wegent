import assert from 'node:assert/strict'

const PRIMARY = process.platform === 'win32' ? 'Control' : 'Meta'
const DRAFT = 'Conversation shortcut regression draft'

export async function verifyConversationShortcuts(control, composerSelector) {
  const originalDraft = await control.command('getValue', composerSelector)
  await control.command('fill', composerSelector, { value: DRAFT })

  const collapsed =
    Number(await control.command('getElementCount', '[data-testid="expand-sidebar-button"]')) > 0
  const toggledSidebar = collapsed ? 'collapse-sidebar-button' : 'expand-sidebar-button'
  const restoredSidebar = collapsed ? 'expand-sidebar-button' : 'collapse-sidebar-button'
  await control.command('nativePress', composerSelector, { key: `${PRIMARY}+B` })
  await control.command('waitFor', `[data-testid="${toggledSidebar}"]`)
  await control.command('nativePress', composerSelector, { key: `${PRIMARY}+B` })
  await control.command('waitFor', `[data-testid="${restoredSidebar}"]`)

  await control.command('nativePress', composerSelector, { key: 'Control+Shift+M' })
  await control.command('waitFor', '[data-testid="model-selector-menu"]')
  await control.command('click', '[data-testid="model-selector-button"]')

  await control.command('nativePress', composerSelector, { key: `${PRIMARY}+Alt+B` })
  await control.command('waitFor', '[data-testid="right-workspace-launcher"]')
  await control.command('nativePress', composerSelector, { key: `${PRIMARY}+Alt+B` })
  assert.equal(
    await control.command('getAttribute', '[data-testid="right-workspace-panel-shell"]', {
      value: 'aria-hidden',
    }),
    'true'
  )
  assert.equal(await control.command('getValue', composerSelector), DRAFT)

  // Native selection and replacement must still belong to the composer.
  await control.command('nativePress', composerSelector, { key: `${PRIMARY}+A` })
  await control.command('nativePress', composerSelector, { key: 'x' })
  assert.equal(await control.command('getValue', composerSelector), 'x')
  await control.command('fill', composerSelector, { value: originalDraft })
}
