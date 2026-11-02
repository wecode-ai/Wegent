// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import dynamic from 'next/dynamic'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { ImagePreview } from '@/components/common/FilePreview/preview-renderers/ImagePreview'
import { TextPreview } from '@/components/common/FilePreview/preview-renderers/TextPreview'
import { VideoPreview } from '@/components/common/FilePreview/preview-renderers/VideoPreview'
import { useTranslation } from '@/hooks/useTranslation'
import type { DocumentLinkResource } from '../utils/documentLinkResource'
import { useDocumentLinkPreview } from '../hooks/useDocumentLinkPreview'

const FlyfishOfficePreview = dynamic(
  () =>
    import('@/components/common/FilePreview/preview-renderers/FlyfishOfficePreview').then(
      module => module.FlyfishOfficePreview
    ),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    ),
  }
)

interface DocumentLinkPreviewProps {
  resource: DocumentLinkResource | null
  onOpenChange: (open: boolean) => void
}

export function DocumentLinkPreview({ resource, onOpenChange }: DocumentLinkPreviewProps) {
  const { t } = useTranslation('knowledge')
  const { state, retry, fail } = useDocumentLinkPreview(resource)

  const renderContent = () => {
    if (!resource || state.status === 'idle' || state.status === 'loading') {
      return (
        <div className="flex h-full min-h-64 items-center justify-center gap-2">
          <Spinner />
          <span>{t('document.document.detail.linkPreview.loading')}</span>
        </div>
      )
    }
    if (state.status === 'error') {
      return (
        <div
          className="flex h-full min-h-64 flex-col items-center justify-center gap-3 p-6 text-center"
          data-testid="document-link-preview-error"
        >
          <AlertCircle className="h-10 w-10 text-error" aria-hidden="true" />
          <p className="text-sm text-text-secondary">
            {t(`document.document.detail.linkPreview.errors.${state.code}`)}
          </p>
          {![
            'expired',
            'unsupported-type',
            'too-complex',
            'video-range-required',
            'parse-failed',
            'codec-unsupported',
          ].includes(state.code) && (
            <Button
              variant="outline"
              onClick={() => void retry()}
              data-testid="document-link-preview-retry"
            >
              <RefreshCw className="h-4 w-4" />
              {t('document.document.detail.linkPreview.retry')}
            </Button>
          )}
        </div>
      )
    }

    if (resource.kindHint === 'video') {
      return (
        <VideoPreview url={resource.url} restricted onError={() => fail('codec-unsupported')} />
      )
    }
    if (resource.kindHint === 'image' && state.blobUrl) {
      return (
        <ImagePreview
          url={state.blobUrl}
          filename={resource.filename}
          restricted
          onError={() => fail('parse-failed')}
        />
      )
    }
    if (resource.kindHint === 'text' && state.blob) {
      return <TextBlobPreview blob={state.blob} filename={resource.filename} />
    }
    if (resource.kindHint === 'pdf') {
      return (
        <FlyfishOfficePreview
          blob={state.blob}
          url={state.validatedUrl}
          validatedRemotePdf={!!state.validatedUrl}
          filename={resource.filename}
          restricted
          onError={() => fail('preview-failed')}
        />
      )
    }
    if (resource.kindHint === 'office' && state.blob) {
      return (
        <FlyfishOfficePreview
          blob={state.blob}
          filename={resource.filename}
          restricted
          onError={() => fail('parse-failed')}
        />
      )
    }
    return null
  }

  return (
    <Dialog open={!!resource} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[82vh] w-[94vw] max-w-6xl flex-col p-4 sm:p-6"
        data-testid="document-link-preview-dialog"
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle className="truncate">{resource?.label}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
          {renderContent()}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TextBlobPreview({ blob, filename }: { blob: Blob; filename: string }) {
  const [content, setContent] = useState('')
  useEffect(() => {
    let active = true
    void blob.text().then(value => active && setContent(value))
    return () => {
      active = false
    }
  }, [blob])
  return <TextPreview content={content} filename={filename} />
}
