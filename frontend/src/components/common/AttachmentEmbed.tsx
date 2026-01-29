// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useMemo } from 'react'
import { Loader2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import ImagePreview from '@/components/common/ImagePreview'
import { useTranslation } from '@/hooks/useTranslation'
import { useAttachmentPreview } from '@/hooks/useAttachmentPreview'
import { useAttachmentImage } from '@/hooks/useAttachmentImage'
import { downloadAttachment, isImageExtension } from '@/apis/attachments'

interface AttachmentEmbedProps {
  attachmentId: number
  theme?: 'light' | 'dark'
}

export default function AttachmentEmbed({ attachmentId, theme = 'light' }: AttachmentEmbedProps) {
  const { t } = useTranslation('common')
  const { data, isLoading, error } = useAttachmentPreview(attachmentId)

  const isImage = useMemo(() => {
    if (!data) return false
    if (data.preview_type === 'image') return true
    return isImageExtension(data.file_extension)
  }, [data])

  const {
    blobUrl: imageUrl,
    isLoading: imageLoading,
    error: imageError,
  } = useAttachmentImage(attachmentId, isImage)

  const handleDownload = async () => {
    try {
      await downloadAttachment(attachmentId, data?.filename)
    } catch (err) {
      console.error('Failed to download attachment:', err)
    }
  }

  if (isLoading) {
    return (
      <div
        data-attachment-embed="true"
        className="flex items-center gap-3 p-4 rounded-lg border border-border bg-surface"
      >
        <div className="flex-shrink-0 w-10 h-10 flex items-center justify-center bg-muted rounded-md">
          <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-text-secondary">{t('attachment.preview.loading')}</div>
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div data-attachment-embed="true" className="text-sm text-red-600">
        <span className="inline-flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {t('attachment.preview.unavailable')}
        </span>
      </div>
    )
  }

  const previewText = data.preview_text?.trim() || ''
  const isPreviewTruncated =
    previewText.length > 0 &&
    typeof data.text_length === 'number' &&
    data.text_length > previewText.length

  return (
    <div data-attachment-embed="true">
      {isImage ? (
        imageLoading ? (
          <div className="flex items-center gap-2 text-sm text-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('attachment.preview.loading')}
          </div>
        ) : imageUrl && !imageError ? (
          <ImagePreview src={imageUrl} alt={data.filename} />
        ) : (
          <div className="text-sm text-text-muted">{t('attachment.preview.unavailable')}</div>
        )
      ) : previewText ? (
        <>
          <EnhancedMarkdown
            source={previewText}
            theme={theme}
            components={{
              a: ({ href, children }) => {
                if (!href) {
                  return <span>{children}</span>
                }
                const isExternal = /^https?:\/\//i.test(href)
                return (
                  <a
                    href={href}
                    target={isExternal ? '_blank' : undefined}
                    rel={isExternal ? 'noopener noreferrer' : undefined}
                    className="text-primary hover:underline"
                  >
                    {children}
                  </a>
                )
              },
              img: ({ src, alt }) => {
                if (!src || typeof src !== 'string') return null
                return <ImagePreview src={src} alt={alt} />
              },
            }}
          />
          {isPreviewTruncated && (
            <div className="text-xs text-text-muted mt-2">
              {t('attachment.truncation.notice', {
                original: data.text_length?.toLocaleString(),
                truncated: previewText.length.toLocaleString(),
              })}
            </div>
          )}
        </>
      ) : (
        <Button variant="ghost" size="sm" onClick={handleDownload}>
          {data.filename || t('download')}
        </Button>
      )}

      {data.status === 'failed' && data.error_message && (
        <div className="text-xs text-red-600 mt-2">{data.error_message}</div>
      )}
    </div>
  )
}
