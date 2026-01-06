// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { TFunction } from 'i18next'

/**
 * Format document count with proper singular/plural form
 *
 * @param count - Number of documents
 * @param t - Translation function from useTranslation (any namespace)
 * @returns Formatted string like "1 document" or "5 documents"
 *
 * @example
 * ```tsx
 * const { t } = useTranslation('chat');
 * const text = formatDocumentCount(5, t); // "5 documents" (en) or "5 篇文档" (zh)
 * ```
 */
export function formatDocumentCount(count: number, t: TFunction): string {
  return t(count === 1 ? 'knowledge:document_count' : 'knowledge:documents_count', { count })
}
