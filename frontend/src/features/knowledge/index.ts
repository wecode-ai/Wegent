// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// What is left of the legacy wiki feature: the add-repository flow on the knowledge
// page, and the hook behind it. Its viewer went with the orphaned project page.
export { default as AddRepoModal } from './AddRepoModal'
export { default as CancelConfirmDialog } from './CancelConfirmDialog'
export { useWikiProjects } from './useWikiProjects'

// Document Knowledge exports
export { KnowledgeDocumentPage } from './document/components'
export { useKnowledgeBases, useDocuments } from './document/hooks'
