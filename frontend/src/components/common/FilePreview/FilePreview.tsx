// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState } from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import {
  ImagePreview,
  PDFPreview,
  TextPreview,
  VideoPreview,
  AudioPreview,
  ExcelPreview,
  WordPreview,
  HtmlPreview,
  UnknownPreview,
} from './preview-renderers'
import { useFileBlob, useExcelParser } from './hooks'
import { getPreviewType, getOfficeType } from './utils'

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
  showToolbar = true,
  htmlIsSourceMode,
  onHtmlViewModeChange,
}: FilePreviewProps) {
  const [textContent, setTextContent] = useState<string>('')
  const previewType = getPreviewType(mimeType, filename)

  const { blob, blobUrl, isLoading, error } = useFileBlob(attachmentId, fileBlob, shareToken)

  const { sheets, parseExcel } = useExcelParser()

  // Parse text, HTML and Excel content when blob is available
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
      } else if (previewType === 'office') {
        const officeType = getOfficeType(filename)
        if (officeType === 'excel') {
          await parseExcel(blob)
        } else {
          // Word/PPT - try to read as text
          try {
            const text = await blob.text()
            setTextContent(text)
          } catch (err) {
            console.error('Failed to read office content:', err)
          }
        }
      }
    }

    parseContent()
  }, [blob, previewType, filename, parseExcel])

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

    case 'office': {
      const officeType = getOfficeType(filename)
      if (officeType === 'excel') {
        return <ExcelPreview sheets={sheets} filename={filename} />
      }
      return <WordPreview content={textContent} filename={filename} />
    }

    case 'unknown':
    default:
      return <UnknownPreview filename={filename} fileSize={fileSize} />
  }
}
