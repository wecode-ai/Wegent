// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import {
  FileText,
  Trash2,
  Pencil,
  ExternalLink,
  Table2,
  MoreVertical,
  Globe,
  CloudDownload,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import type { KnowledgeDocument } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'

interface DocumentItemProps {
  document: KnowledgeDocument
  onEdit?: (doc: KnowledgeDocument) => void
  onDelete?: (doc: KnowledgeDocument) => void
  onRefresh?: (doc: KnowledgeDocument) => void
  onViewDetail?: (doc: KnowledgeDocument) => void
  canManage?: boolean
  showBorder?: boolean
  selected?: boolean
  onSelect?: (doc: KnowledgeDocument, selected: boolean) => void
  /** Compact mode for sidebar display - uses card layout */
  compact?: boolean
  /** Whether the document is currently being refreshed */
  isRefreshing?: boolean
}

export function DocumentItem({
  document,
  onEdit,
  onDelete,
  onRefresh,
  onViewDetail,
  canManage = true,
  showBorder = true,
  selected = false,
  onSelect,
  compact = false,
  isRefreshing = false,
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

  const handleRefresh = (e: React.MouseEvent) => {
    e.stopPropagation()
    onRefresh?.(document)
  }

  const handleOpenLink = (e: React.MouseEvent) => {
    e.stopPropagation()
    const url = document.source_config?.url
    if (url && typeof url === 'string') {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }
  // Check document source type
  const isTable = document.source_type === 'table'
  const isWeb = document.source_type === 'web'
  // URL for table or web documents
  const sourceUrl =
    (isTable || isWeb) &&
    document.source_config?.url &&
    typeof document.source_config.url === 'string'
      ? document.source_config.url
      : null

  // Get display name - for web documents, remove .md extension
  const displayName =
    isWeb && document.name.endsWith('.md') ? document.name.slice(0, -3) : document.name

  const handleRowClick = () => {
    onViewDetail?.(document)
  }

  // Compact mode: Card layout for sidebar (notebook mode)
  if (compact) {
    return (
      <div
        className={`flex items-center gap-2 px-2 py-2 bg-base hover:bg-surface transition-colors rounded-lg border border-border group ${onViewDetail ? 'cursor-pointer' : ''}`}
        onClick={handleRowClick}
      >
        {/* Checkbox for batch selection */}
        {canManage && (
          <div className="flex-shrink-0" onClick={handleCheckboxClick}>
            <Checkbox
              checked={selected}
              onCheckedChange={handleCheckboxChange}
              className="data-[state=checked]:bg-primary data-[state=checked]:border-primary h-3.5 w-3.5"
            />
          </div>
        )}

        {/* File name and info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            <span className="text-xs font-medium text-text-primary truncate">{displayName}</span>
            {sourceUrl && (
              <button
                className="p-0.5 rounded text-primary hover:bg-primary/10 transition-colors flex-shrink-0"
                onClick={handleOpenLink}
                title={t('knowledge:document.document.openLink')}
              >
                <ExternalLink className="w-2.5 h-2.5" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            {/* Type badge */}
            {isTable ? (
              <Badge
                variant="default"
                size="sm"
                className="bg-blue-500/10 text-blue-600 border-blue-500/20 text-[9px] px-1 py-0"
              >
                {t('knowledge:document.document.type.table')}
              </Badge>
            ) : isWeb ? (
              <Badge
                variant="default"
                size="sm"
                className="bg-green-500/10 text-green-600 border-green-500/20 text-[9px] px-1 py-0"
              >
                {t('knowledge:document.document.type.web')}
              </Badge>
            ) : (
              <span className="text-[9px] text-text-muted uppercase">
                {document.file_extension}
              </span>
            )}
            {/* Size */}
            {!isTable && !isWeb && (
              <span className="text-[9px] text-text-muted">
                {formatFileSize(document.file_size)}
              </span>
            )}
            {/* Status indicator */}
            <span
              className={`w-1 h-1 rounded-full flex-shrink-0 ${document.is_active ? 'bg-green-500' : 'bg-yellow-500'}`}
              title={
                document.is_active
                  ? t('knowledge:document.document.indexStatus.available')
                  : t('knowledge:document.document.indexStatus.unavailable')
              }
            />
          </div>
        </div>

        {/* File icon / More actions - icon shown by default, more actions on hover */}
        <div className="flex-shrink-0 relative w-6 h-6 flex items-center justify-center">
          {/* File icon - hidden on hover when canManage */}
          <div
            className={`p-1 bg-primary/10 rounded ${canManage ? 'group-hover:opacity-0' : ''} transition-opacity`}
          >
            {isTable ? (
              <Table2 className="w-3 h-3 text-primary" />
            ) : isWeb ? (
              <Globe className="w-3 h-3 text-primary" />
            ) : (
              <FileText className="w-3 h-3 text-primary" />
            )}
          </div>
          {/* More actions dropdown - shown on hover, replaces icon */}
          {canManage && (
            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface transition-colors"
                    onClick={e => e.stopPropagation()}
                  >
                    <MoreVertical className="w-3.5 h-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[120px]">
                  <DropdownMenuItem onClick={handleEdit}>
                    <Pencil className="w-3.5 h-3.5 mr-2" />
                    {t('common:actions.edit')}
                  </DropdownMenuItem>
                  {isWeb && onRefresh && (
                    <DropdownMenuItem onClick={handleRefresh} disabled={isRefreshing}>
                      <CloudDownload
                        className={`w-3.5 h-3.5 mr-2 ${isRefreshing ? 'animate-pulse' : ''}`}
                      />
                      {isRefreshing
                        ? t('knowledge:document.upload.web.refetching')
                        : t('knowledge:document.upload.web.refetch')}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem danger onClick={handleDelete}>
                    <Trash2 className="w-3.5 h-3.5 mr-2" />
                    {t('common:actions.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Normal mode: Table row layout
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
        ) : isWeb ? (
          <Globe className="w-4 h-4 text-primary" />
        ) : (
          <FileText className="w-4 h-4 text-primary" />
        )}
      </div>

      {/* File name */}
      <div className="flex-1 min-w-[120px] flex items-center gap-2">
        <span className="text-sm font-medium text-text-primary truncate">{displayName}</span>
        {sourceUrl && (
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
        ) : isWeb ? (
          <Badge
            variant="default"
            size="sm"
            className="bg-green-500/10 text-green-600 border-green-500/20"
          >
            {t('knowledge:document.document.type.web')}
          </Badge>
        ) : (
          <span className="text-xs text-text-muted uppercase">{document.file_extension}</span>
        )}
      </div>

      {/* Size */}
      <div className="w-20 flex-shrink-0 text-center">
        <span className="text-xs text-text-muted">
          {isTable || isWeb ? '-' : formatFileSize(document.file_size)}
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

      {/* Action buttons */}
      {canManage && (
        <div className="w-20 flex-shrink-0 flex items-center justify-center gap-1">
          {/* Re-fetch button - only for web documents */}
          {isWeb && onRefresh && (
            <button
              className={`p-1.5 rounded-md transition-colors ${
                isRefreshing
                  ? 'text-primary cursor-not-allowed'
                  : 'text-text-muted hover:text-primary hover:bg-primary/10'
              }`}
              onClick={handleRefresh}
              disabled={isRefreshing}
              title={
                isRefreshing
                  ? t('knowledge:document.upload.web.refetching')
                  : t('knowledge:document.upload.web.refetch')
              }
            >
              <CloudDownload className={`w-4 h-4 ${isRefreshing ? 'animate-pulse' : ''}`} />
            </button>
          )}
          {/* Delete button */}
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
