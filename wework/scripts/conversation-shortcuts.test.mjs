// @vitest-environment node

import assert from 'node:assert/strict'
import { test } from 'vitest'
import { verifyConversationShortcuts } from '../e2e/desktop/modules/conversation-shortcuts.mjs'

test('dismisses the modal model picker before resuming composer shortcuts', async () => {
  const composer = '[data-testid="chat-message-input"]'
  let draft = 'Existing draft'
  let sidebar = true
  let rightPanel = null
  let menuOpen = false
  let findOpen = false
  let query = ''
  let escapedPicker = false
  const control = {
    async command(action, selector, options = {}) {
      if (action === 'getValue') return selector === composer ? draft : query
      if (action === 'fill') {
        if (selector === composer) draft = options.value
        else query = options.value
        return ''
      }
      if (action === 'getElementCount') {
        if (selector.includes('expand-sidebar-button')) return sidebar ? '0' : '1'
        if (selector.includes('conversation-find-input')) return findOpen ? '1' : '0'
      }
      if (action === 'getAttribute') {
        if (selector.includes('right-workspace-panel-shell')) return String(!rightPanel)
        if (selector.includes('conversation-find-next-button')) return ''
      }
      if (action === 'click' && selector.includes('model-selector-button')) {
        assert.equal(menuOpen, false, 'The modal picker makes its background trigger inert')
      }
      if (action === 'nativePress') {
        const key = options.key
        if (menuOpen) {
          assert.equal(key, 'Escape', 'Composer shortcuts must not target an inert background')
          menuOpen = false
          escapedPicker = true
        } else if (key === 'Control+Shift+M') menuOpen = true
        else if (key.endsWith('+Alt+B')) rightPanel = rightPanel ? null : 'launcher'
        else if (key.endsWith('+Alt+S')) rightPanel = 'chat'
        else if (key.endsWith('+B')) sidebar = !sidebar
        else if (key.endsWith('+F')) findOpen = true
        else if (key === 'Escape') {
          findOpen = false
          query = ''
        } else if (key === 'x') draft = 'x'
        return ''
      }
      if (action === 'waitFor') {
        if (selector.includes('model-selector-menu'))
          assert.equal(menuOpen, options.visible !== false)
        if (selector.includes('expand-sidebar-button')) assert.equal(sidebar, false)
        if (selector.includes('collapse-sidebar-button')) assert.equal(sidebar, true)
        if (selector.includes('right-workspace-launcher')) assert.equal(rightPanel, 'launcher')
        if (selector.includes('right-workspace-chat-panel')) assert.equal(rightPanel, 'chat')
        if (selector.includes('conversation-find-input')) assert.equal(findOpen, true)
        return ''
      }
      throw new Error(`Unexpected control command: ${action} ${selector}`)
    },
  }

  await verifyConversationShortcuts(control, composer, 'Existing reply')

  assert.equal(escapedPicker, true)
  assert.equal(menuOpen, false)
  assert.equal(draft, 'Existing draft')
  assert.equal(sidebar, true)
  assert.equal(rightPanel, null)
  assert.equal(findOpen, false)
})
