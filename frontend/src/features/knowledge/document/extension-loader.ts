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

export function loadKBExtensions(): Promise<void> {
  if (!EXTENSION_MODULE) {
    return Promise.resolve()
  }
  return import(EXTENSION_MODULE).then(() => {})
}
