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
  RotateCcw,
  Download,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { downloadAttachment } from '@/apis/attachments'
import type { KnowledgeDocument } from '@/types/knowledge'
import { useTranslation } from '@/hooks/useTranslation'
import { toast } from '@/hooks/use-toast'

interface DocumentItemProps {
  document: KnowledgeDocument
  onEdit?: (doc: KnowledgeDocument) => void
  onDelete?: (doc: KnowledgeDocument) => void
  onRefresh?: (doc: KnowledgeDocument) => void
  onReindex?: (doc: KnowledgeDocument) => void
  onViewDetail?: (doc: KnowledgeDocument) => void
  canManage?: boolean
  showBorder?: boolean
  selected?: boolean
  onSelect?: (doc: KnowledgeDocument, selected: boolean) => void
  /** Compact mode for sidebar display - uses card layout */
  compact?: boolean
  /** Whether the document is currently being refreshed */
  isRefreshing?: boolean
  /** Whether the document is currently being reindexed */
  isReindexing?: boolean
  /** Whether the knowledge base has RAG configured (retriever + embedding model) */
  ragConfigured?: boolean
  /** Width of the name column in pixels (for table mode column resize) */
  nameColumnWidth?: number
}

export function DocumentItem({
  document,
  onEdit,
  onDelete,
  onRefresh,
  onReindex,
  onViewDetail,
  canManage = true,
  showBorder = true,
  selected = false,
  onSelect,
  compact = false,
  isRefreshing = false,
  isReindexing = false,
  ragConfigured = true,
  nameColumnWidth,
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

  const handleReindex = (e: React.MouseEvent) => {
    e.stopPropagation()
    onReindex?.(document)
  }

  const handleOpenLink = (e: React.MouseEvent) => {
    e.stopPropagation()
    const url = document.source_config?.url
    if (url && typeof url === 'string') {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (document.source_type === 'file' && document.attachment_id) {
      try {
        await downloadAttachment(document.attachment_id, document.name)
      } catch {
        toast({
          title: t('knowledge:document.document.downloadFailed'),
          variant: 'destructive',
        })
      }
    }
  }

  // Whether to show download button
  const showDownload = document.source_type === 'file' && !!document.attachment_id
  // Check document source type
  const isTable = document.source_type === 'table'
  const isWeb = document.source_type === 'web'
  const isNotIndexed = document.index_status === 'not_indexed'
  const isIndexFailed = document.index_status === 'failed'
  const isBackendIndexing =
    document.index_status === 'queued' || document.index_status === 'indexing'
  const showIndexingState = isReindexing || isBackendIndexing
  const canReindex =
    ragConfigured &&
    !isTable &&
    !!onReindex &&
    (isIndexFailed || isNotIndexed) &&
    !showIndexingState

  // Check if Excel file exceeds size limit (2MB)
  const EXCEL_FILE_SIZE_LIMIT = 2 * 1024 * 1024 // 2MB
  const isExcel = ['xls', 'xlsx'].includes(document.file_extension?.toLowerCase() || '')
  const isExcelExceedingSizeLimit = isExcel && document.file_size > EXCEL_FILE_SIZE_LIMIT
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

  let unavailableHint = t('knowledge:document.document.indexStatus.unavailableHint')
  if (isExcelExceedingSizeLimit) {
    unavailableHint = t('knowledge:document.document.excelFileSizeExceeded', {
      extension: document.file_extension,
      limit: 2,
      size: (document.file_size / (1024 * 1024)).toFixed(2),
    })
  } else if (isNotIndexed) {
    unavailableHint = t('knowledge:document.document.indexStatus.notIndexedHint')
  }

  const unavailableLabel = isNotIndexed
    ? t('knowledge:document.document.indexStatus.notIndexed')
    : t('knowledge:document.document.indexStatus.unavailable')

  const unavailableDotColor = isNotIndexed ? 'bg-slate-400' : 'bg-yellow-500'

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
            <TooltipProvider>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <span className="text-xs font-medium text-text-primary truncate">
                    {displayName}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">
                  <p className="text-xs break-all">{displayName}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
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
            {document.is_active ? (
              <span
                className="w-1 h-1 rounded-full flex-shrink-0 bg-green-500"
                title={t('knowledge:document.document.indexStatus.available')}
              />
            ) : showIndexingState ? (
              <TooltipProvider>
                <Tooltip delayDuration={200}>
                  <TooltipTrigger asChild>
                    <span className="w-1 h-1 rounded-full flex-shrink-0 bg-blue-500 cursor-help animate-pulse" />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <p className="text-xs">
                      {t('knowledge:document.document.indexStatus.indexingHint')}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <TooltipProvider>
                <Tooltip delayDuration={200}>
                  <TooltipTrigger asChild>
                    <span
                      className={`w-1 h-1 rounded-full flex-shrink-0 cursor-help ${unavailableDotColor}`}
                    />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <p className="text-xs">{unavailableHint}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
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
                  {canReindex && (
                    <DropdownMenuItem onClick={handleReindex} disabled={showIndexingState}>
                      <RotateCcw
                        className={`w-3.5 h-3.5 mr-2 ${showIndexingState ? 'animate-spin' : ''}`}
                      />
                      {showIndexingState
                        ? t('knowledge:document.document.reindexing')
                        : isNotIndexed
                          ? t('knowledge:document.document.index')
                          : t('knowledge:document.document.reindex')}
                    </DropdownMenuItem>
                  )}
                  {showDownload && (
                    <DropdownMenuItem onClick={handleDownload}>
                      <Download className="w-3.5 h-3.5 mr-2" />
                      {t('knowledge:document.document.download')}
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
      className={`flex items-center gap-4 px-4 py-3 bg-base hover:bg-surface transition-colors group min-w-[800px] ${showBorder ? 'border-b border-border' : ''} ${onViewDetail ? 'cursor-pointer' : ''}`}
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
      <div
        className={`flex items-center gap-2 ${nameColumnWidth ? 'flex-shrink-0' : 'flex-1 min-w-[120px]'}`}
        style={nameColumnWidth ? { width: `${nameColumnWidth}px` } : undefined}
      >
        <TooltipProvider>
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <span className="text-sm font-medium text-text-primary truncate">{displayName}</span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              <p className="text-xs break-all">{displayName}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
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
        {document.is_active ? (
          <Badge variant="success" size="sm" className="whitespace-nowrap">
            {t('knowledge:document.document.indexStatus.available')}
          </Badge>
        ) : showIndexingState ? (
          <TooltipProvider>
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <span>
                  <Badge
                    variant="default"
                    size="sm"
                    className="whitespace-nowrap cursor-help bg-blue-500/10 text-blue-600 border-blue-500/20"
                  >
                    {t('knowledge:document.document.indexStatus.indexing')}
                  </Badge>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <p className="text-xs">
                  {t('knowledge:document.document.indexStatus.indexingHint')}
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <TooltipProvider>
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <span>
                  <Badge variant="warning" size="sm" className="whitespace-nowrap cursor-help">
                    {unavailableLabel}
                  </Badge>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <p className="text-xs">{unavailableHint}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
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
          {/* Reindex button - only when RAG configured and document not indexed */}
          {canReindex && (
            <button
              className={`p-1.5 rounded-md transition-colors ${
                showIndexingState
                  ? 'text-primary cursor-not-allowed'
                  : 'text-text-muted hover:text-primary hover:bg-primary/10'
              }`}
              onClick={handleReindex}
              disabled={showIndexingState}
              title={
                showIndexingState
                  ? t('knowledge:document.document.reindexing')
                  : t('knowledge:document.document.reindex')
              }
            >
              <RotateCcw className={`w-4 h-4 ${showIndexingState ? 'animate-spin' : ''}`} />
            </button>
          )}
          {/* Download button - only for file documents with attachment */}
          {showDownload && (
            <button
              className="p-1.5 rounded-md text-text-muted hover:text-primary hover:bg-primary/10 transition-colors"
              onClick={handleDownload}
              title={t('knowledge:document.document.download')}
            >
              <Download className="w-4 h-4" />
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
