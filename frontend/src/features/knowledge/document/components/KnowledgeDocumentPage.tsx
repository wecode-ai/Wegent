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

export function KnowledgeDocumentPage() {
  const isMobile = useIsMobile()

  if (isMobile) {
    return <KnowledgeDocumentPageMobile />
  }

  return <KnowledgeDocumentPageDesktop />
}
