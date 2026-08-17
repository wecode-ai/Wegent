// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type KnowledgePresentationTranslate = (
  key: string,
  params?: Record<string, unknown>
) => string

export interface KnowledgeScopePresentationInput {
  documentCount?: number | null
  documentIds?: readonly number[] | null
  folderIds?: readonly number[] | null
  scopeRestricted?: boolean | null
}

export function formatCompactKnowledgeScope(
  folderCount: number,
  documentCount: number,
  t: KnowledgePresentationTranslate
): string {
  if (folderCount > 0 && documentCount > 0) {
    return t('knowledge:picker.scopeMixedCompact', { folderCount, documentCount })
  }
  if (folderCount > 0) {
    return t('knowledge:picker.scopeFoldersCompact', { count: folderCount })
  }
  return t('knowledge:picker.scopeDocumentsCompact', { count: documentCount })
}

export function formatKnowledgeScopeSummary(
  scope: KnowledgeScopePresentationInput,
  t: KnowledgePresentationTranslate
): string | undefined {
  if (scope.scopeRestricted) {
    return formatCompactKnowledgeScope(
      scope.folderIds?.length ?? 0,
      scope.documentIds?.length ?? 0,
      t
    )
  }

  if (scope.documentCount === undefined || scope.documentCount === null) {
    return undefined
  }

  return t('knowledge:picker.scopeAllDocuments', { count: scope.documentCount })
}
