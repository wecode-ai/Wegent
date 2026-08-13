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

  const { requireKnowledgeDocumentProtectionExtension } =
    await import('@/features/knowledge/document/document-protection-registry')
  requireKnowledgeDocumentProtectionExtension()

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

  try {
    await import('@wecode/features/knowledge/document-protection')
  } catch (error) {
    console.warn('Failed to load knowledge document protection', error)
  }

  try {
    await import('@wecode/features/knowledge/document-video-preview')
  } catch (error) {
    console.warn('Failed to load video document preview', error)
  }

  try {
    await import('@wecode/features/knowledge/video-segment-source-opener')
  } catch (error) {
    console.warn('Failed to load video segment source opener', error)
  }
}
