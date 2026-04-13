// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState } from 'react'
import { Download, Loader2, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { downloadAttachment, getAttachment, getFileIcon } from '@/apis/attachments'
import type { AttachmentDetailResponse } from '@/apis/attachments'
import { useShareToken } from '@/contexts/ShareTokenContext'
import { FilePreviewDialog, isFilePreviewable } from '@/components/common/FilePreview'
import { useTranslation } from '@/hooks/useTranslation'

// Global cache for attachment details to avoid redundant API calls
const attachmentCache = new Map<number, AttachmentDetailResponse>()

interface AttachmentCardProps {
  /** Attachment ID */
  attachmentId: number
}

/**
 * AttachmentCard component displays a file attachment as a card with preview and download options
 *
 * Features:
 * - Fetches attachment details from API (with caching)
 * - File icon based on extension
 * - Filename and type label
 * - Preview button (opens dialog)
 * - Download button (downloads with authentication)
 *
 * Note: Uses <span> instead of <div> to avoid hydration errors when rendered inside <p> tags by Markdown
 */
export function AttachmentCard({ attachmentId }: AttachmentCardProps) {
  const { shareToken } = useShareToken()
  const { t } = useTranslation('common')
  const [attachment, setAttachment] = useState<AttachmentDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)

  // Fetch attachment details on mount (with caching)
  useEffect(() => {
    const fetchAttachment = async () => {
      try {
        setLoading(true)

        // Check cache first
        const cached = attachmentCache.get(attachmentId)
        if (cached) {
          setAttachment(cached)
          setLoading(false)
          return
        }

        // Fetch from API if not cached
        const data = await getAttachment(attachmentId, shareToken)
        attachmentCache.set(attachmentId, data) // Cache the result
        setAttachment(data)
      } catch (err) {
        console.error('Failed to fetch attachment:', err)
        setError(err instanceof Error ? err.message : 'Failed to load attachment')
      } finally {
        setLoading(false)
      }
    }

    fetchAttachment()
  }, [attachmentId, shareToken])

  const handleDownload = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      await downloadAttachment(attachmentId, attachment?.filename, shareToken)
    } catch (error) {
      console.error('Failed to download attachment:', error)
    }
  }

  const handlePreview = () => {
    setPreviewOpen(true)
  }

  const handleClosePreview = () => {
    setPreviewOpen(false)
  }

  // Loading state - use span with display:block to avoid hydration error in <p>
  if (loading) {
    return (
      <span className="flex items-center gap-4 p-4 rounded-xl border border-border bg-surface w-full">
        <span className="flex-shrink-0 w-16 h-16 flex items-center justify-center bg-base rounded-lg border border-border">
          <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
        </span>
        <span className="flex-1 min-w-0 block">
          <span className="block h-5 bg-border rounded animate-pulse mb-2 w-3/4" />
          <span className="block h-4 bg-border rounded animate-pulse w-1/2" />
        </span>
      </span>
    )
  }

  // Error state - use span with display:block
  if (error || !attachment) {
    return (
      <span className="flex items-center gap-4 p-4 rounded-xl border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/20 w-full">
        <span className="flex-shrink-0 w-16 h-16 flex items-center justify-center bg-base rounded-lg border border-border">
          <span className="text-3xl">⚠️</span>
        </span>
        <span className="flex-1 min-w-0 block">
          <span className="block text-base font-medium text-red-800 dark:text-red-200">
            Failed to load attachment
          </span>
          <span className="block text-sm text-red-600 dark:text-red-400">
            {error || 'Unknown error'}
          </span>
        </span>
      </span>
    )
  }

  // Get file icon emoji
  const fileIcon = getFileIcon(attachment.file_extension)

  // Get file type label
  const fileTypeLabel = getFileTypeLabel(attachment.file_extension)

  // Check if file is previewable
  const isPreviewable = isFilePreviewable(attachment.mime_type, attachment.file_extension)

  return (
    <>
      <span
        className={`flex items-center gap-4 p-4 rounded-xl border border-border bg-surface hover:bg-surface-hover transition-colors w-full ${isPreviewable ? 'cursor-pointer' : ''}`}
        onClick={isPreviewable ? handlePreview : undefined}
      >
        {/* File Icon */}
        <span className="flex-shrink-0 w-16 h-16 flex items-center justify-center bg-base rounded-lg border border-border">
          <span className="text-3xl">{fileIcon}</span>
        </span>

        {/* File Info */}
        <span className="flex-1 min-w-0 block">
          <span
            className="block text-base font-medium text-text-primary truncate"
            title={attachment.filename}
          >
            {attachment.filename}
          </span>
          <span className="block text-sm text-text-secondary">
            {fileTypeLabel} · {attachment.file_extension.replace('.', '').toUpperCase()}
          </span>
        </span>

        {/* Action Buttons */}
        <span className="flex items-center gap-2 flex-shrink-0">
          {/* Preview Button */}
          {isPreviewable && (
            <Button
              variant="ghost"
              size="icon"
              onClick={e => {
                e.stopPropagation()
                handlePreview()
              }}
              className="h-10 w-10 rounded-lg hover:bg-primary/10"
              title={t('actions.preview')}
            >
              <Eye className="h-5 w-5 text-text-secondary" />
            </Button>
          )}

          {/* Download Button */}
          <Button
            variant="outline"
            onClick={handleDownload}
            className="h-10 px-4 rounded-lg hover:bg-primary/10"
          >
            <Download className="h-4 w-4 mr-2" />
            Download
          </Button>
        </span>
      </span>

      {/* Preview Dialog */}
      {isPreviewable && (
        <FilePreviewDialog
          open={previewOpen}
          onClose={handleClosePreview}
          attachmentId={attachmentId}
          filename={attachment.filename}
          mimeType={attachment.mime_type}
          fileSize={attachment.file_size}
          shareToken={shareToken}
          canShare={!shareToken}
        />
      )}
    </>
  )
}

/**
 * Get file type label based on extension
 */
function getFileTypeLabel(extension: string): string {
  const ext = extension.toLowerCase().replace('.', '')

  // Document types
  if (['pdf'].includes(ext)) return 'Document'
  if (['doc', 'docx'].includes(ext)) return 'Word Document'
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'Spreadsheet'
  if (['ppt', 'pptx'].includes(ext)) return 'Presentation'
  if (['txt', 'md'].includes(ext)) return 'Text'

  // Web types
  if (['html', 'htm', 'html5'].includes(ext)) return 'Web Page'

  // Image types
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) return 'Image'

  // Code types
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'go', 'rs', 'cpp', 'c'].includes(ext)) return 'Code'

  // Config types
  if (['json', 'yaml', 'yml', 'xml', 'toml'].includes(ext)) return 'Configuration'

  // Default
  return 'File'
}

export default AttachmentCard
