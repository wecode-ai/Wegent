// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Chrome Extension Service Worker
 * Handles background tasks, context menus, and message passing
 */

import browser from 'webextension-polyfill'

// Context menu IDs
const MENU_ID_SEND_TO_CHAT = 'wegent-send-to-chat'
const MENU_ID_ADD_TO_KB = 'wegent-add-to-kb'

/**
 * Initialize context menus
 */
function setupContextMenus(): void {
  // Remove existing menus first
  browser.contextMenus.removeAll().then(() => {
    // Create "Send to Wegent Chat" menu item
    browser.contextMenus.create({
      id: MENU_ID_SEND_TO_CHAT,
      title: 'Send to Wegent Chat',
      contexts: ['selection'],
    })

    // Create "Add to Wegent Knowledge Base" menu item
    browser.contextMenus.create({
      id: MENU_ID_ADD_TO_KB,
      title: 'Add to Wegent Knowledge Base',
      contexts: ['selection'],
    })
  })
}

/**
 * Handle context menu clicks
 */
browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return

  const selectedText = info.selectionText || ''

  if (info.menuItemId === MENU_ID_SEND_TO_CHAT) {
    // Store selected text and open popup in chat mode
    await browser.storage.local.set({
      pendingAction: 'chat',
      pendingText: selectedText,
      pendingUrl: tab.url,
      pendingTitle: tab.title,
    })

    // Open the popup
    await browser.action.openPopup()
  } else if (info.menuItemId === MENU_ID_ADD_TO_KB) {
    // Store selected text and open popup in knowledge base mode
    await browser.storage.local.set({
      pendingAction: 'knowledge',
      pendingText: selectedText,
      pendingUrl: tab.url,
      pendingTitle: tab.title,
    })

    // Open the popup
    await browser.action.openPopup()
  }
})

/**
 * Handle messages from content script or popup
 */
browser.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse) => {
    const msg = message as {
      type: string
      data?: unknown
    }

    if (msg.type === 'GET_PAGE_CONTENT') {
      // Forward to content script
      browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        if (tabs[0]?.id) {
          browser.tabs.sendMessage(tabs[0].id, { type: 'EXTRACT_CONTENT' }).then(
            (response) => sendResponse(response),
            (error) => sendResponse({ error: error.message }),
          )
        }
      })
      return true // Will respond asynchronously
    }

    if (msg.type === 'GET_SELECTED_TEXT') {
      // Forward to content script
      browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        if (tabs[0]?.id) {
          browser.tabs.sendMessage(tabs[0].id, { type: 'GET_SELECTION' }).then(
            (response) => sendResponse(response),
            (error) => sendResponse({ error: error.message }),
          )
        }
      })
      return true // Will respond asynchronously
    }

    if (msg.type === 'OPEN_CHAT_PAGE') {
      const data = msg.data as { taskId: number; serverUrl: string }
      // Open the chat page in a new tab
      browser.tabs.create({
        url: `${data.serverUrl}/chat/${data.taskId}`,
      })
      return false
    }

    if (msg.type === 'CLEAR_PENDING_ACTION') {
      browser.storage.local.remove([
        'pendingAction',
        'pendingText',
        'pendingUrl',
        'pendingTitle',
      ])
      return false
    }

    return false
  },
)

/**
 * Handle installation
 */
browser.runtime.onInstalled.addListener(() => {
  setupContextMenus()
})

// Initialize on startup
setupContextMenus()
