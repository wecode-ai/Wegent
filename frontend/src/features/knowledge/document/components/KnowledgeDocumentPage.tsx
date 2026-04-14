// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * KnowledgeDocumentPage - Router component for document knowledge.
 *
 * Routes between desktop (tree + detail layout) and mobile (full-screen switch) modes.
 * Desktop: Left knowledge tree panel + right detail area
 * Mobile: Full-screen knowledge tree, selecting a KB navigates to its detail page
 */

'use client'

import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { KnowledgeDocumentPageDesktop } from './KnowledgeDocumentPageDesktop'
import { KnowledgeDocumentPageMobile } from './KnowledgeDocumentPageMobile'

interface KnowledgeDocumentPageProps {
  /** Initial KB namespace to auto-select (from virtual URL path) */
  initialKbNamespace?: string
  /** Initial KB name to auto-select (from virtual URL path) */
  initialKbName?: string
  /** Initial document path to auto-open (from virtual URL path segments) */
  initialDocPath?: string
}

export function KnowledgeDocumentPage({
  initialKbNamespace,
  initialKbName,
  initialDocPath,
}: KnowledgeDocumentPageProps = {}) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <KnowledgeDocumentPageMobile
        initialKbNamespace={initialKbNamespace}
        initialKbName={initialKbName}
        initialDocPath={initialDocPath}
      />
    )
  }

  return (
    <KnowledgeDocumentPageDesktop
      initialKbNamespace={initialKbNamespace}
      initialKbName={initialKbName}
      initialDocPath={initialDocPath}
    />
  )
}
