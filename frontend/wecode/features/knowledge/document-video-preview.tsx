// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { isVideoExtension } from '@/apis/attachments'
import { getToken } from '@/apis/user'
import { useTranslation } from '@/hooks/useTranslation'
import {
  registerKnowledgeDocumentPreviewExtension,
  type KnowledgeDocumentPreviewExtension,
} from '@/features/knowledge/document/document-preview-registry'

interface PlayUrlResponse {
  url: string
  mime_type?: string
}

export function isVideoDocument(
  document: { file_extension?: string; attachment_id?: number | null } | null | undefined
): boolean {
  if (!document || !document.attachment_id) return false
  const ext = document.file_extension?.trim().toLowerCase() || ''
  const dottedExt = ext.startsWith('.') ? ext : `.${ext}`
  return isVideoExtension(dottedExt)
}

export function useVideoPlayUrl(
  documentId: number,
  enabled: boolean
): {
  playUrl: string | null
  mimeType: string
  isLoading: boolean
  notReady: boolean
  hasError: boolean
  retry: () => void
} {
  const [playUrl, setPlayUrl] = useState<string | null>(null)
  const [mimeType, setMimeType] = useState('video/mp4')
  const [isLoading, setIsLoading] = useState(enabled)
  const [notReady, setNotReady] = useState(false)
  const [hasError, setHasError] = useState(false)
  const [requestVersion, setRequestVersion] = useState(0)
  const retry = useCallback(() => setRequestVersion(version => version + 1), [])

  useEffect(() => {
    setPlayUrl(null)
    setMimeType('video/mp4')
    setNotReady(false)
    setHasError(false)
    if (!enabled) {
      setIsLoading(false)
      return
    }

    let isMounted = true
    const controller = new AbortController()
    const resolve = async () => {
      setIsLoading(true)
      try {
        const token = getToken()
        const response = await fetch(`/api/knowledge-documents/${documentId}/video-play-url`, {
          method: 'GET',
          headers: { ...(token && { Authorization: `Bearer ${token}` }) },
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) {
          if (response.status === 409) {
            if (isMounted) setNotReady(true)
            return
          }
          throw new Error(`Failed to resolve video URL: ${response.status}`)
        }
        const data = (await response.json()) as PlayUrlResponse
        const url = new URL(data.url)
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
          throw new Error('Unsupported video URL protocol')
        }
        if (isMounted) {
          setPlayUrl(url.toString())
          setMimeType(data.mime_type ?? 'video/mp4')
        }
      } catch (error) {
        if (isMounted && !(error instanceof DOMException && error.name === 'AbortError')) {
          setHasError(true)
        }
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }
    void resolve()
    return () => {
      isMounted = false
      controller.abort()
    }
  }, [documentId, enabled, requestVersion])

  return { playUrl, mimeType, isLoading, notReady, hasError, retry }
}

function MultimodalVideoPreview({ documentId, name }: { documentId: number; name: string }) {
  const { t } = useTranslation('knowledge')
  const { playUrl, mimeType, isLoading, notReady, hasError, retry } = useVideoPlayUrl(
    documentId,
    true
  )
  const videoRef = useRef<HTMLVideoElement>(null)
  const [videoError, setVideoError] = useState(false)

  if (isLoading) {
    return (
      <div
        className="flex min-h-[120px] min-w-[200px] animate-pulse items-center justify-center rounded-lg bg-surface"
        data-testid="multimodal-video-preview-loading"
      >
        <Spinner />
      </div>
    )
  }

  if (notReady || !playUrl || videoError) {
    const showError = hasError || videoError
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-surface p-4 text-xs text-text-muted">
        <AlertCircle className="h-4 w-4" />
        <span>
          {notReady
            ? t('document.multimodal.videoPreview.notReady')
            : showError
              ? t('document.multimodal.videoPreview.loadFailed')
              : name}
        </span>
        {(notReady || showError) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setVideoError(false)
              retry()
            }}
            data-testid="video-preview-retry"
          >
            {t('document.multimodal.videoPreview.retry')}
          </Button>
        )}
      </div>
    )
  }

  return (
    <video
      ref={videoRef}
      controls
      preload="metadata"
      onError={() => setVideoError(true)}
      className="max-h-[600px] max-w-full rounded-lg border border-border bg-black"
      data-testid="multimodal-video-preview"
    >
      <source src={playUrl} type={mimeType} />
    </video>
  )
}

const videoDocumentPreviewExtension: KnowledgeDocumentPreviewExtension = {
  supports: isVideoDocument,
  render: ({ document, className }) => (
    <div className={className}>
      <MultimodalVideoPreview documentId={document.id} name={document.name || 'Video document'} />
    </div>
  ),
}

registerKnowledgeDocumentPreviewExtension(videoDocumentPreviewExtension)
