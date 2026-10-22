import assert from 'node:assert/strict'

const PRIMARY = process.platform === 'win32' ? 'Control' : 'Meta'
const NATIVE_PRIMARY = process.platform === 'darwin' ? 'Meta' : 'Control'
const DRAFT = 'Conversation shortcut regression draft'

export async function verifyEmptyConversationFind(control, composerSelector) {
  await control.command('waitFor', '[data-testid="desktop-empty-composer-frame"]')
  const draft = await control.command('getValue', composerSelector)
  const input = '[data-testid="conversation-find-input"]'
  await control.command('nativePress', composerSelector, { key: `${NATIVE_PRIMARY}+F` })
  await control.command('waitFor', input)
  await control.command('fill', input, { value: 'WEWORK_EMPTY_CHAT_FIND_SENTINEL' })
  assert.equal(
    await control.command('getAttribute', '[data-testid="conversation-find-next-button"]', {
      value: 'disabled',
    }),
    ''
  )
  await control.command('nativePress', input, { key: 'Escape' })
  assert.equal(Number(await control.command('getElementCount', input)), 0)
  assert.equal(await control.command('getValue', composerSelector), draft)
}

export async function verifyConversationShortcuts(control, composerSelector, searchQuery) {
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

  await control.command('nativePress', composerSelector, { key: `${NATIVE_PRIMARY}+Alt+S` })
  await control.command('waitFor', '[data-testid="right-workspace-chat-panel"]')
  assert.equal(
    await control.command('getAttribute', '[data-testid="right-workspace-panel-shell"]', {
      value: 'aria-hidden',
    }),
    'false'
  )
  assert.equal(await control.command('getValue', composerSelector), DRAFT)
  await control.command('nativePress', composerSelector, { key: `${PRIMARY}+Alt+B` })

  // Native selection and replacement must still belong to the composer.
  await control.command('nativePress', composerSelector, { key: `${NATIVE_PRIMARY}+A` })
  await control.command('nativePress', composerSelector, { key: 'x' })
  assert.equal(await control.command('getValue', composerSelector), 'x')
  await control.command('fill', composerSelector, { value: originalDraft })

  const input = '[data-testid="conversation-find-input"]'
  const count = '[data-testid="conversation-find-count"]'
  await control.command('nativePress', composerSelector, { key: `${NATIVE_PRIMARY}+F` })
  await control.command('waitFor', input)
  await control.command('fill', input, { value: searchQuery })
  await control.command('waitFor', count, { text: '1', timeoutMs: 10_000 })
  await control.command('nativePress', input, { key: 'Enter' })
  await control.command('nativePress', input, { key: 'Shift+Enter' })
  await control.command('nativePress', input, { key: `${NATIVE_PRIMARY}+F` })
  assert.equal(await control.command('getValue', input), searchQuery)
  await control.command('fill', input, { value: 'WEWORK_FIND_NO_MATCH_SENTINEL' })
  assert.equal(
    await control.command('getAttribute', '[data-testid="conversation-find-next-button"]', {
      value: 'disabled',
    }),
    ''
  )
  await control.command('nativePress', input, { key: 'Escape' })
  assert.equal(Number(await control.command('getElementCount', input)), 0)
  assert.equal(await control.command('getValue', composerSelector), originalDraft)
  await control.command('nativePress', composerSelector, { key: `${NATIVE_PRIMARY}+F` })
  await control.command('waitFor', input)
  assert.equal(await control.command('getValue', input), '')
  await control.command('nativePress', input, { key: 'Escape' })
  assert.equal(Number(await control.command('getElementCount', input)), 0)
}
