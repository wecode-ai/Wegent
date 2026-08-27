// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { BookOpen, Folder, FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DingtalkDocNode } from '@/types/dingtalk-doc'
import { DocumentFormatIcon } from './DocumentFormatIcon'

export function DingtalkNodeIcon({
  node,
  expanded = false,
}: {
  node: DingtalkDocNode
  expanded?: boolean
}) {
  const folder = node.node_type === 'folder'
  if (!folder) {
    return <DocumentFormatIcon extension={node.extension} />
  }
  const wikiRoot = node.source === 'wikispace' && node.dingtalk_node_id === node.workspace_id
  const Icon = wikiRoot ? BookOpen : expanded ? FolderOpen : Folder
  return (
    <Icon className={cn('h-4 w-4 shrink-0', wikiRoot ? 'text-primary' : 'text-text-secondary')} />
  )
}
