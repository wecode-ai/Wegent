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
  (message: unknown, _sender, sendResponse) => {
    const msg = message as { type: string }

    if (msg.type === 'EXTRACT_CONTENT') {
      try {
        const content = extractPageContent(document)
        sendResponse({
          success: true,
          data: content,
        })
      } catch (error) {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to extract content',
        })
      }
      return true
    }

    if (msg.type === 'GET_SELECTION') {
      try {
        const selection = window.getSelection()?.toString() || ''

        if (!selection) {
          sendResponse({
            success: true,
            data: null,
          })
          return true
        }

        const content = extractSelectedText(selection, document)
        sendResponse({
          success: true,
          data: content,
        })
      } catch (error) {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get selection',
        })
      }
      return true
    }

    return false
  },
)

// Log that content script is loaded
console.log('[Wegent] Content script loaded')
