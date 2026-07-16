// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import dynamic from 'next/dynamic'
import React, { useEffect, useState } from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import {
  ImagePreview,
  PDFPreview,
  TextPreview,
  VideoPreview,
  AudioPreview,
  HtmlPreview,
  UnknownPreview,
} from './preview-renderers'
import { useFileBlob } from './hooks'
import { getPreviewType } from './utils'

const FlyfishOfficePreview = dynamic(
  () =>
    import('./preview-renderers/FlyfishOfficePreview').then(module => module.FlyfishOfficePreview),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    ),
  }
)

export interface FilePreviewProps {
  /** Attachment ID for fetching file */
  attachmentId?: number
  /** Direct file blob (alternative to attachmentId) */
  fileBlob?: Blob
  /** Filename for display and type detection */
  filename: string
  /** MIME type for type detection */
  mimeType: string
  /** File size for display */
  fileSize?: number
  /** Optional share token for public access */
  shareToken?: string
  /** Callback when download is requested */
  onDownload?: () => void
  /** Callback when close is requested */
  onClose?: () => void
  /** Callback when a renderer fails */
  onError?: (error: Error) => void
  /** Whether to show toolbar (for fullscreen mode) */
  showToolbar?: boolean
  /** HTML preview mode: false = preview, true = source (controlled) */
  htmlIsSourceMode?: boolean
  /** Callback when HTML preview mode changes */
  onHtmlViewModeChange?: (isSourceMode: boolean) => void
}

/**
 * FilePreview component - Renders preview for various file types
 * Supports: image, PDF, text, video, audio, Excel, Word/PPT
 */
export function FilePreview({
  attachmentId,
  fileBlob,
  filename,
  mimeType,
  fileSize,
  shareToken,
  onDownload,
  onClose,
  onError,
  showToolbar = true,
  htmlIsSourceMode,
  onHtmlViewModeChange,
}: FilePreviewProps) {
  const [textContent, setTextContent] = useState<string>('')
  const previewType = getPreviewType(mimeType, filename)

  const { blob, blobUrl, isLoading, error } = useFileBlob(attachmentId, fileBlob, shareToken)

  // Parse text and HTML content when blob is available
  useEffect(() => {
    if (!blob) return

    const parseContent = async () => {
      if (previewType === 'text' || previewType === 'html') {
        try {
          const text = await blob.text()
          setTextContent(text)
        } catch (err) {
          console.error('Failed to read text content:', err)
        }
      }
    }

    parseContent()
  }, [blob, previewType])

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[200px]">
        <Loader2 className="w-8 h-8 animate-spin text-primary mb-2" />
        <p className="text-text-secondary text-sm">加载中...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[200px] p-4">
        <AlertCircle className="w-12 h-12 text-red-500 mb-2" />
        <p className="text-red-600 text-sm text-center">{error}</p>
      </div>
    )
  }

  // Render based on preview type
  switch (previewType) {
    case 'image':
      return blobUrl ? (
        <ImagePreview
          url={blobUrl}
          filename={filename}
          onDownload={onDownload}
          onClose={onClose}
          showToolbar={showToolbar}
        />
      ) : null

    case 'pdf':
      return blobUrl ? <PDFPreview url={blobUrl} filename={filename} /> : null

    case 'text':
      return <TextPreview content={textContent} filename={filename} />

    case 'html':
      return (
        <HtmlPreview
          content={textContent}
          filename={filename}
          isSourceMode={htmlIsSourceMode}
          onViewModeChange={onHtmlViewModeChange}
        />
      )

    case 'video':
      return blobUrl ? <VideoPreview url={blobUrl} /> : null

    case 'audio':
      return blobUrl ? <AudioPreview url={blobUrl} filename={filename} /> : null

    case 'office':
      return blob ? (
        <FlyfishOfficePreview blob={blob} filename={filename} onError={onError} />
      ) : null

    case 'unknown':
    default:
      return <UnknownPreview filename={filename} fileSize={fileSize} />
  }
}
