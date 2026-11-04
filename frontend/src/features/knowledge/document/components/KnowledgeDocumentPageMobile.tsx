// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

'use client'

import {
  KnowledgeDocumentWorkspace,
  type KnowledgeDocumentWorkspaceProps,
} from './KnowledgeDocumentWorkspace'

export function KnowledgeDocumentPageMobile(
  props: Omit<KnowledgeDocumentWorkspaceProps, 'mobile'> = {}
) {
  return <KnowledgeDocumentWorkspace {...props} mobile />
}
