// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * KB extension loader.
 *
 * Internal build: dynamically loads @wecode/features/knowledge so its
 * side effects (registering ERP department permission UI etc.) run at
 * page mount. The module specifier is a literal string, which both
 * webpack and Turbopack can statically analyze and bundle.
 */

export async function loadKBExtensions(): Promise<void> {
  try {
    await import('@wecode/features/knowledge')
  } catch (error) {
    console.warn('Failed to load KB extension @wecode/features/knowledge', error)
  }
}
