// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  BookOpen,
  File,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  Link2,
  Presentation,
  Table2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DingtalkDocNode } from '@/types/dingtalk-doc'

const FILE_ICONS = new Map<string, { icon: typeof FileText; className: string }>([
  ['adoc', { icon: FileText, className: 'text-blue-600 dark:text-blue-400' }],
  ['docx', { icon: FileText, className: 'text-blue-600 dark:text-blue-400' }],
  ['pdf', { icon: FileText, className: 'text-error' }],
  ['txt', { icon: FileText, className: 'text-blue-600 dark:text-blue-400' }],
  ['md', { icon: FileText, className: 'text-blue-600 dark:text-blue-400' }],
  ['dlink', { icon: Link2, className: 'text-blue-600 dark:text-blue-400' }],
  ['able', { icon: Table2, className: 'text-primary' }],
  ['axls', { icon: FileSpreadsheet, className: 'text-green-600 dark:text-green-400' }],
  ['xlsx', { icon: FileSpreadsheet, className: 'text-green-600 dark:text-green-400' }],
  ['csv', { icon: FileSpreadsheet, className: 'text-green-600 dark:text-green-400' }],
  ['appt', { icon: Presentation, className: 'text-orange-600 dark:text-orange-400' }],
  ['pptx', { icon: Presentation, className: 'text-orange-600 dark:text-orange-400' }],
])

export function DingtalkNodeIcon({
  node,
  expanded = false,
}: {
  node: DingtalkDocNode
  expanded?: boolean
}) {
  const folder = node.node_type === 'folder'
  const wikiRoot =
    folder && node.source === 'wikispace' && node.dingtalk_node_id === node.workspace_id
  const fileIcon = FILE_ICONS.get(node.extension ?? '')
  const Icon = wikiRoot
    ? BookOpen
    : folder
      ? expanded
        ? FolderOpen
        : Folder
      : (fileIcon?.icon ?? File)
  return (
    <Icon
      className={cn(
        'h-4 w-4 shrink-0',
        wikiRoot
          ? 'text-primary'
          : folder
            ? 'text-text-secondary'
            : (fileIcon?.className ?? 'text-text-muted')
      )}
    />
  )
}
