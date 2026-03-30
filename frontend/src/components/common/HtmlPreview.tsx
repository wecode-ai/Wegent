// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { getAttachmentPreview } from '@/apis/attachments'
import { HtmlPreview as HtmlPreviewBase } from '@/components/common/FilePreview/preview-renderers/HtmlPreview'

interface HtmlPreviewProps {
  attachmentId: number
  filename: string
  shareToken?: string | null
}

/**
 * HtmlPreview component for embedded attachment display.
 * Wraps the base HtmlPreview component with data loading logic.
 */
export default function HtmlPreview({ attachmentId, filename, shareToken }: HtmlPreviewProps) {
  const { t } = useTranslation('common')
  const [content, setContent] = useState<string>('')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isPreviewAvailable, setIsPreviewAvailable] = useState(true)

  // Load HTML content
  useEffect(() => {
    // Reset state at the start of loading
    setError(null)
    setIsLoading(true)
    setIsPreviewAvailable(true)
    setContent('')

    // Cancellation guard
    let cancelled = false

    const loadContent = async () => {
      try {
        const response = await getAttachmentPreview(attachmentId, shareToken || undefined)

        // Check cancellation guard before updating state
        if (cancelled) {
          return
        }

        // Check preview_type and preview_text before setting content
        if (response.preview_type === 'none' || !response.preview_text) {
          setIsPreviewAvailable(false)
          setContent('')
        } else {
          setIsPreviewAvailable(true)
          setContent(response.preview_text)
        }
      } catch (err) {
        // Check cancellation guard before updating state
        if (cancelled) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to load HTML')
      } finally {
        // Check cancellation guard before updating state
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    loadContent()

    // Cleanup function to set cancelled flag
    return () => {
      cancelled = true
    }
  }, [attachmentId, shareToken])

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-text-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('attachment.preview.loading')}
      </div>
    )
  }

  if (error) {
    return <div className="text-sm text-red-600">{t('attachment.preview.unavailable')}</div>
  }

  if (!isPreviewAvailable) {
    return <div className="text-sm text-text-muted">{t('attachment.preview.unavailable')}</div>
  }

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <HtmlPreviewBase content={content} filename={filename} />
    </div>
  )
}
