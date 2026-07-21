// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Knowledge base extension loader.
 *
 * The module path is injected at build time via the environment variable
 * NEXT_PUBLIC_KB_EXTENSION_MODULE. In open-source builds this variable is
 * unset and the loader is a no-op. Internal builds set it to
 * @wecode/features/knowledge via webpack DefinePlugin or .env.
 */

const EXTENSION_MODULE =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_KB_EXTENSION_MODULE) || ''

let coreExtensionsLoaded = false

async function loadCoreKnowledgeExtensions(): Promise<void> {
  if (coreExtensionsLoaded) {
    return
  }

  try {
    const { registerDingTalkExternalKnowledgeSource } =
      await import('@/features/knowledge/dingtalkExternalKnowledgeSource')
    registerDingTalkExternalKnowledgeSource()
    coreExtensionsLoaded = true
  } catch (error) {
    console.warn('Failed to load core knowledge extensions', error)
  }
}

export async function loadKBExtensions(): Promise<void> {
  await loadCoreKnowledgeExtensions()

  if (!EXTENSION_MODULE) {
    return
  }

  try {
    await import(/* webpackIgnore: true */ EXTENSION_MODULE)
  } catch (error) {
    console.warn(`Failed to load KB extension module "${EXTENSION_MODULE}"`, error)
  }
}
