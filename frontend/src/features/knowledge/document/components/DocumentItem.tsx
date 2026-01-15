// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { FileText, Trash2, Pencil, ExternalLink, Table2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import type { KnowledgeDocument } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'

interface DocumentItemProps {
  document: KnowledgeDocument
  onEdit?: (doc: KnowledgeDocument) => void
  onDelete?: (doc: KnowledgeDocument) => void
  onViewDetail?: (doc: KnowledgeDocument) => void
  canManage?: boolean
  showBorder?: boolean
  selected?: boolean
  onSelect?: (doc: KnowledgeDocument, selected: boolean) => void
}

export function DocumentItem({
  document,
  onEdit,
  onDelete,
  onViewDetail,
  canManage = true,
  showBorder = true,
  selected = false,
  onSelect,
}: DocumentItemProps) {
  const { t } = useTranslation()

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  // Format date with time to seconds level: YYYY/MM/DD HH:mm:ss
  const formatDateTime = (dateString: string) => {
    const date = new Date(dateString)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    const seconds = String(date.getSeconds()).padStart(2, '0')
    return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`
  }

  const handleCheckboxChange = (checked: boolean) => {
    onSelect?.(document, checked)
  }

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation()
  }

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    onEdit?.(document)
  }

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    onDelete?.(document)
  }

  const handleOpenLink = (e: React.MouseEvent) => {
    e.stopPropagation()
    const url = document.source_config?.url
    if (url && typeof url === 'string') {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }

  // Check if this is a table document
  const isTable = document.source_type === 'table'
  const tableUrl =
    isTable && document.source_config?.url && typeof document.source_config.url === 'string'
      ? document.source_config.url
      : null
  const handleRowClick = () => {
    onViewDetail?.(document)
  }

  return (
    <div
      className={`flex items-center gap-4 px-4 py-3 bg-base hover:bg-surface transition-colors group ${showBorder ? 'border-b border-border' : ''} ${onViewDetail ? 'cursor-pointer' : ''}`}
      onClick={handleRowClick}
    >
      {/* Checkbox for batch selection */}
      {canManage && (
        <div className="flex-shrink-0" onClick={handleCheckboxClick}>
          <Checkbox
            checked={selected}
            onCheckedChange={handleCheckboxChange}
            className="data-[state=checked]:bg-primary data-[state=checked]:border-primary"
          />
        </div>
      )}

      {/* File icon */}
      <div className="p-2 bg-primary/10 rounded-lg flex-shrink-0">
        {isTable ? (
          <Table2 className="w-4 h-4 text-primary" />
        ) : (
          <FileText className="w-4 h-4 text-primary" />
        )}
      </div>

      {/* File name */}
      <div className="flex-1 min-w-[120px] flex items-center gap-2">
        <span className="text-sm font-medium text-text-primary truncate">{document.name}</span>
        {tableUrl && (
          <button
            className="p-1 rounded-md text-primary hover:bg-primary/10 transition-colors flex-shrink-0"
            onClick={handleOpenLink}
            title={t('knowledge:document.document.openLink')}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Edit button - in the middle area */}
      <div className="w-48 flex-shrink-0 flex items-center justify-center">
        {canManage && (
          <button
            className="p-1 rounded-md text-primary hover:bg-primary/10 transition-colors"
            onClick={handleEdit}
            title={t('common:actions.edit')}
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Type */}
      <div className="w-20 flex-shrink-0 text-center">
        {isTable ? (
          <Badge
            variant="default"
            size="sm"
            className="bg-blue-500/10 text-blue-600 border-blue-500/20"
          >
            {t('knowledge:document.document.type.table')}
          </Badge>
        ) : (
          <span className="text-xs text-text-muted uppercase">{document.file_extension}</span>
        )}
      </div>

      {/* Size */}
      <div className="w-20 flex-shrink-0 text-center">
        <span className="text-xs text-text-muted">
          {isTable ? '-' : formatFileSize(document.file_size)}
        </span>
      </div>

      {/* Upload date with time */}
      <div className="w-40 flex-shrink-0 text-center">
        <span className="text-xs text-text-muted">{formatDateTime(document.created_at)}</span>
      </div>

      {/* Index status (is_active) */}
      <div className="w-24 flex-shrink-0 text-center">
        <Badge
          variant={document.is_active ? 'success' : 'warning'}
          size="sm"
          className="whitespace-nowrap"
        >
          {document.is_active
            ? t('knowledge:document.document.indexStatus.available')
            : t('knowledge:document.document.indexStatus.unavailable')}
        </Badge>
      </div>

      {/* Action button - delete only */}
      {canManage && (
        <div className="w-16 flex-shrink-0 flex items-center justify-center">
          <button
            className="p-1.5 rounded-md text-text-muted hover:text-error hover:bg-error/10 transition-colors"
            onClick={handleDelete}
            title={t('common:actions.delete')}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  )
}
