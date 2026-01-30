// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Chrome Extension Content Script
 * Runs in the context of web pages to extract content
 */

import browser from 'webextension-polyfill'
import { extractPageContent, extractSelectedText } from '@shared/extractor'

/**
 * Handle messages from the service worker or popup
 */
browser.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse): true | void => {
    const msg = message as { type: string }
    // Cast sendResponse to accept any argument (webextension-polyfill types are too strict)
    const respond = sendResponse as (response: unknown) => void

    console.log('[Wegent CS] Received message:', msg.type)

    // Handle ping from service worker to check if content script is loaded
    if (msg.type === 'PING') {
      console.log('[Wegent CS] Responding to PING')
      respond({ pong: true })
      return
    }

    if (msg.type === 'EXTRACT_CONTENT') {
      console.log('[Wegent CS] Extracting page content')
      try {
        const content = extractPageContent(document)
        console.log('[Wegent CS] Content extracted successfully')
        respond({
          success: true,
          data: content,
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to extract content'
        console.error('[Wegent CS] Error extracting content:', errorMessage, error)
        respond({
          success: false,
          error: errorMessage,
        })
      }
      return true
    }

    if (msg.type === 'GET_SELECTION') {
      console.log('[Wegent CS] Getting selection')
      try {
        const selection = window.getSelection()?.toString() || ''
        console.log('[Wegent CS] Selection length:', selection.length)

        if (!selection) {
          console.log('[Wegent CS] No selection found')
          respond({
            success: true,
            data: null,
          })
          return true
        }

        const content = extractSelectedText(selection, document)
        console.log('[Wegent CS] Selection extracted successfully')
        respond({
          success: true,
          data: content,
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to get selection'
        console.error('[Wegent CS] Error getting selection:', errorMessage, error)
        respond({
          success: false,
          error: errorMessage,
        })
      }
      return true
    }

    console.log('[Wegent CS] Unknown message type:', msg.type)
    return
  },
)

// Log that content script is loaded
console.log('[Wegent CS] Content script loaded on:', window.location.href)
