// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { downloadAttachment, getAttachment, getFileIcon } from '@/apis/attachments'
import type { AttachmentDetailResponse } from '@/apis/attachments'

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
 * - Preview button (opens in new tab)
 * - Download button (downloads with authentication)
 */
export function AttachmentCard({ attachmentId }: AttachmentCardProps) {
  const [attachment, setAttachment] = useState<AttachmentDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
        const data = await getAttachment(attachmentId)
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
  }, [attachmentId])

  const handleDownload = async (e: React.MouseEvent) => {
    e.preventDefault()
    try {
      await downloadAttachment(attachmentId)
    } catch (error) {
      console.error('Failed to download attachment:', error)
    }
  }

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center gap-4 p-4 rounded-xl border border-border bg-surface">
        <div className="flex-shrink-0 w-16 h-16 flex items-center justify-center bg-base rounded-lg border border-border">
          <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="h-5 bg-border rounded animate-pulse mb-2 w-3/4" />
          <div className="h-4 bg-border rounded animate-pulse w-1/2" />
        </div>
      </div>
    )
  }

  // Error state
  if (error || !attachment) {
    return (
      <div className="flex items-center gap-4 p-4 rounded-xl border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/20">
        <div className="flex-shrink-0 w-16 h-16 flex items-center justify-center bg-base rounded-lg border border-border">
          <span className="text-3xl">⚠️</span>
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-medium text-red-800 dark:text-red-200">
            Failed to load attachment
          </h3>
          <p className="text-sm text-red-600 dark:text-red-400">{error || 'Unknown error'}</p>
        </div>
      </div>
    )
  }

  // Get file icon emoji
  const fileIcon = getFileIcon(attachment.file_extension)

  // Get file type label
  const fileTypeLabel = getFileTypeLabel(attachment.file_extension)

  return (
    <div className="flex items-center gap-4 p-4 rounded-xl border border-border bg-surface hover:bg-surface-hover transition-colors">
      {/* File Icon */}
      <div className="flex-shrink-0 w-16 h-16 flex items-center justify-center bg-base rounded-lg border border-border">
        <span className="text-3xl">{fileIcon}</span>
      </div>

      {/* File Info */}
      <div className="flex-1 min-w-0">
        <h3
          className="text-base font-medium text-text-primary truncate"
          title={attachment.filename}
        >
          {attachment.filename}
        </h3>
        <p className="text-sm text-text-secondary">
          {fileTypeLabel} · {attachment.file_extension.replace('.', '').toUpperCase()}
        </p>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {/* Preview Button */}
        {/* <Button
          variant="ghost"
          size="icon"
          onClick={handlePreview}
          className="h-10 w-10 rounded-lg hover:bg-primary/10"
          title="Preview"
        >
          <ExternalLink className="h-5 w-5 text-text-secondary" />
        </Button> */}

        {/* Download Button */}
        <Button
          variant="outline"
          onClick={handleDownload}
          className="h-10 px-4 rounded-lg hover:bg-primary/10"
        >
          <Download className="h-4 w-4 mr-2" />
          Download
        </Button>
      </div>
    </div>
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

  // Image types
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) return 'Image'

  // Code types
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp'].includes(ext)) return 'Code'

  // Config types
  if (['json', 'yaml', 'yml', 'xml', 'toml'].includes(ext)) return 'Configuration'

  // Default
  return 'File'
}

export default AttachmentCard
