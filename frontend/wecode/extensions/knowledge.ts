// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Load internal knowledge extensions.
 *
 * This is the wecode-only bootstrap for AP knowledge integration. Core frontend
 * code must only depend on provider-neutral registries.
 */
export async function loadWecodeKnowledgeExtensions() {
  if (typeof window === 'undefined') {
    return
  }

  try {
    await import('@wecode/features/knowledge/external/ap-source-opener')
  } catch (error) {
    console.warn('Failed to load AP source opener', error)
  }

  try {
    await import('@wecode/features/knowledge/external/ap-knowledge-source')
  } catch (error) {
    console.warn('Failed to load AP knowledge source', error)
  }

  try {
    await import('@wecode/features/knowledge/external/ap-knowledge-source-view')
  } catch (error) {
    console.warn('Failed to load AP knowledge source view', error)
  }
}
