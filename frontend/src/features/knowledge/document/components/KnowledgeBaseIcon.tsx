// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { BookOpen, Code2, Database } from 'lucide-react'
import type { KnowledgeBaseType } from '@/types/knowledge'

/**
 * The icon for a kind of knowledge base.
 *
 * One place rather than a branch at each site. There were four — the sidebar item,
 * the command palette, the tree, and the tree's own icon-name mapping — each written
 * as "classic or not", so adding a third kind left three of them silently rendering
 * a code wiki as a notebook. A component takes the kind itself, so a fourth kind
 * cannot be half-added the same way.
 */
export function KnowledgeBaseIcon({
  kbType,
  className = 'w-3.5 h-3.5',
}: {
  kbType?: KnowledgeBaseType | null
  className?: string
}) {
  if (kbType === 'code_wiki') {
    return <Code2 className={`${className} text-primary`} />
  }
  if (kbType === 'classic') {
    return <Database className={`${className} text-text-secondary`} />
  }
  return <BookOpen className={`${className} text-primary`} />
}
