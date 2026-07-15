// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { AlertCircle, Download, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { fetchAttachmentFile, formatFileSize } from '@/apis/attachments'
import { FilePreview } from '@/components/common/FilePreview'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { KnowledgeDocument } from '@/types/knowledge'
import {
  KNOWLEDGE_SOURCE_PREVIEW_MAX_BYTES,
  isKnowledgeSourcePreviewTooLarge,
} from '../utils/sourcePreview'

interface KnowledgeSourcePreviewProps {
  document: KnowledgeDocument
  active: boolean
  onDownload: () => void
  className?: string
}

export function KnowledgeSourcePreview({
  document,
  active,
  onDownload,
  className,
}: KnowledgeSourcePreviewProps) {
  const { t } = useTranslation('knowledge')
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const tooLarge = isKnowledgeSourcePreviewTooLarge(document.file_size)

  useEffect(() => {
    if (!active || !document.attachment_id || tooLarge) {
      setFile(null)
      setLoading(false)
      setError(null)
      return
    }

    const controller = new AbortController()
    setFile(null)
    setLoading(true)
    setError(null)

    fetchAttachmentFile(document.attachment_id, {
      filename: document.name,
      signal: controller.signal,
    })
      .then(setFile)
      .catch(fetchError => {
        if (controller.signal.aborted) return
        setError(fetchError instanceof Error ? fetchError : new Error(String(fetchError)))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [active, document.attachment_id, document.id, document.name, retryKey, tooLarge])

  let content: ReactNode
  if (tooLarge) {
    content = (
      <PreviewState
        title={t('document.document.detail.sourcePreview.tooLargeTitle')}
        description={t('document.document.detail.sourcePreview.tooLargeDescription', {
          size: formatFileSize(document.file_size),
          limit: formatFileSize(KNOWLEDGE_SOURCE_PREVIEW_MAX_BYTES),
        })}
        action={
          <Button
            type="button"
            variant="primary"
            onClick={onDownload}
            className="max-md:min-h-[44px] max-md:min-w-[44px]"
            data-testid="knowledge-source-preview-too-large-download"
          >
            <Download className="h-4 w-4" />
            {t('document.document.detail.sourcePreview.download')}
          </Button>
        }
      />
    )
  } else if (loading) {
    content = (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-text-secondary">
        <Spinner />
        <p className="text-sm">{t('document.document.detail.sourcePreview.loading')}</p>
      </div>
    )
  } else if (error) {
    content = (
      <PreviewState
        title={t('document.document.detail.sourcePreview.failedTitle')}
        description={t('document.document.detail.sourcePreview.failedDescription')}
        action={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setRetryKey(key => key + 1)}
              className="max-md:min-h-[44px] max-md:min-w-[44px]"
              data-testid="knowledge-source-preview-retry"
            >
              <RefreshCw className="h-4 w-4" />
              {t('common:actions.retry')}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={onDownload}
              className="max-md:min-h-[44px] max-md:min-w-[44px]"
              data-testid="knowledge-source-preview-error-download"
            >
              <Download className="h-4 w-4" />
              {t('document.document.detail.sourcePreview.download')}
            </Button>
          </div>
        }
      />
    )
  } else if (file) {
    content = (
      <FilePreview
        fileBlob={file}
        filename={file.name}
        mimeType={file.type}
        fileSize={file.size}
        showToolbar={false}
        onError={setError}
      />
    )
  } else {
    content = null
  }

  return (
    <section
      className={cn(
        'flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-base md:min-h-[480px]',
        className
      )}
      data-testid="knowledge-source-preview"
    >
      <div className="min-h-0 flex-1 overflow-hidden">{content}</div>
    </section>
  )
}

function PreviewState({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action: ReactNode
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <AlertCircle className="h-8 w-8 text-warning" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-text-primary">{title}</p>
        <p className="max-w-lg text-sm text-text-secondary">{description}</p>
      </div>
      {action}
    </div>
  )
}
