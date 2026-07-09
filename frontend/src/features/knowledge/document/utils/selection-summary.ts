// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

type Translate = (key: string, options?: Record<string, unknown>) => string

type SelectionSummaryKind = 'selected' | 'transferHint' | 'transferSuccess'

const SUMMARY_KEYS: Record<
  SelectionSummaryKind,
  { documents: string; folders: string; mixed: string }
> = {
  selected: {
    documents: 'document.document.batch.selectedDocuments',
    folders: 'document.document.batch.selectedFolders',
    mixed: 'document.document.batch.selectedMixed',
  },
  transferHint: {
    documents: 'document.document.batch.transferHintDocuments',
    folders: 'document.document.batch.transferHintFolders',
    mixed: 'document.document.batch.transferHintMixed',
  },
  transferSuccess: {
    documents: 'document.document.batch.transferSuccessDocuments',
    folders: 'document.document.batch.transferSuccessFolders',
    mixed: 'document.document.batch.transferSuccessMixed',
  },
}

export function formatSelectionSummary(
  t: Translate,
  kind: SelectionSummaryKind,
  documentCount: number,
  folderCount: number
) {
  const keys = SUMMARY_KEYS[kind]
  const options = { docCount: documentCount, folderCount }

  if (folderCount > 0 && documentCount > 0) {
    return t(keys.mixed, options)
  }
  if (folderCount > 0) {
    return t(keys.folders, options)
  }
  return t(keys.documents, options)
}
