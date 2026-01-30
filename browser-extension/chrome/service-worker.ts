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
 * Check if a URL is injectable (content scripts can run on it)
 */
function isInjectableUrl(url: string | undefined): boolean {
  if (!url) return false
  // Content scripts cannot be injected into these URLs
  const nonInjectablePatterns = [
    /^chrome:\/\//,
    /^chrome-extension:\/\//,
    /^moz-extension:\/\//,
    /^edge:\/\//,
    /^about:/,
    /^data:/,
    /^file:\/\//,
    /^view-source:/,
    /^chrome-search:\/\//,
    /^https:\/\/chrome\.google\.com\/webstore/,
    /^https:\/\/addons\.mozilla\.org/,
    /^https:\/\/microsoftedge\.microsoft\.com\/addons/,
  ]
  return !nonInjectablePatterns.some((pattern) => pattern.test(url))
}

/**
 * Ensure content script is injected into the tab
 * Returns true if content script is ready, false otherwise
 */
async function ensureContentScriptInjected(tabId: number): Promise<boolean> {
  console.log('[Wegent SW] ensureContentScriptInjected called for tabId:', tabId)

  // First, try to ping the content script to see if it's already loaded
  try {
    console.log('[Wegent SW] Sending PING to check if content script is loaded')
    const response = await browser.tabs.sendMessage(tabId, { type: 'PING' })
    if (response?.pong) {
      console.log('[Wegent SW] Content script already loaded and responding')
      return true
    }
  } catch (pingError) {
    // Content script not loaded, will try to inject it below
    console.log(
      '[Wegent SW] Content script not loaded (PING failed):',
      pingError instanceof Error ? pingError.message : pingError,
    )
  }

  // Content script not loaded, try to inject it
  try {
    console.log('[Wegent SW] Injecting content script...')
    await browser.scripting.executeScript({
      target: { tabId },
      files: ['content-script.js'],
    })
    console.log('[Wegent SW] Content script injection completed')

    // Wait for the script to initialize and verify it's ready with retries
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      try {
        console.log(`[Wegent SW] Retry ${i + 1}/5: Sending PING to verify content script`)
        const response = await browser.tabs.sendMessage(tabId, { type: 'PING' })
        if (response?.pong) {
          console.log('[Wegent SW] Content script is now ready')
          return true
        }
      } catch (retryError) {
        // Not ready yet, continue waiting
        console.log(
          `[Wegent SW] Retry ${i + 1}/5 failed:`,
          retryError instanceof Error ? retryError.message : retryError,
        )
      }
    }

    console.error('[Wegent SW] Content script injected but not responding after 5 retries')
    return false
  } catch (injectError) {
    console.error('[Wegent SW] Failed to inject content script:', injectError)
    return false
  }
}

/**
 * Send message to content script with retry and fallback
 */
async function sendMessageToContentScript(
  tabId: number,
  tabUrl: string | undefined,
  message: { type: string },
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  console.log('[Wegent SW] sendMessageToContentScript called:', { tabId, tabUrl, message })

  // Check if the URL is injectable
  if (!isInjectableUrl(tabUrl)) {
    console.log('[Wegent SW] URL is not injectable:', tabUrl)
    return {
      success: false,
      error: 'Cannot extract content from this page type (browser internal page)',
    }
  }

  // Ensure content script is injected
  const isReady = await ensureContentScriptInjected(tabId)
  if (!isReady) {
    console.error('[Wegent SW] Content script is not ready')
    return {
      success: false,
      error: 'Failed to initialize content script on this page',
    }
  }

  // Now send the actual message
  try {
    console.log('[Wegent SW] Sending message to content script:', message)
    const response = await browser.tabs.sendMessage(tabId, message)
    console.log('[Wegent SW] Received response from content script:', response)
    return response
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to communicate with page'
    console.error('[Wegent SW] Error sending message to content script:', errorMessage, error)
    return {
      success: false,
      error: errorMessage,
    }
  }
}

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
  (message: unknown, _sender, sendResponse): true | void => {
    const msg = message as {
      type: string
      data?: unknown
    }
    // Cast sendResponse to accept any argument (webextension-polyfill types are too strict)
    const respond = sendResponse as (response: unknown) => void

    console.log('[Wegent SW] Received message:', msg.type)

    if (msg.type === 'GET_PAGE_CONTENT') {
      console.log('[Wegent SW] Handling GET_PAGE_CONTENT')
      // Forward to content script with proper error handling
      browser.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
        console.log('[Wegent SW] Active tabs:', tabs.length, tabs[0]?.url)
        if (tabs[0]?.id) {
          const response = await sendMessageToContentScript(
            tabs[0].id,
            tabs[0].url,
            { type: 'EXTRACT_CONTENT' },
          )
          console.log('[Wegent SW] GET_PAGE_CONTENT response:', response)
          respond(response)
        } else {
          console.error('[Wegent SW] No active tab found')
          respond({ success: false, error: 'No active tab found' })
        }
      })
      return true // Will respond asynchronously
    }

    if (msg.type === 'GET_SELECTED_TEXT') {
      console.log('[Wegent SW] Handling GET_SELECTED_TEXT')
      // Forward to content script with proper error handling
      browser.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
        console.log('[Wegent SW] Active tabs:', tabs.length, tabs[0]?.url)
        if (tabs[0]?.id) {
          const response = await sendMessageToContentScript(
            tabs[0].id,
            tabs[0].url,
            { type: 'GET_SELECTION' },
          )
          console.log('[Wegent SW] GET_SELECTED_TEXT response:', response)
          respond(response)
        } else {
          console.error('[Wegent SW] No active tab found')
          respond({ success: false, error: 'No active tab found' })
        }
      })
      return true // Will respond asynchronously
    }

    if (msg.type === 'OPEN_CHAT_PAGE') {
      const data = msg.data as { taskId: number; frontendUrl: string }
      // Open the chat page in a new tab
      browser.tabs.create({
        url: `${data.frontendUrl}/chat?taskId=${data.taskId}`,
      })
      return
    }

    if (msg.type === 'CLEAR_PENDING_ACTION') {
      browser.storage.local.remove([
        'pendingAction',
        'pendingText',
        'pendingUrl',
        'pendingTitle',
      ])
      return
    }

    return
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
