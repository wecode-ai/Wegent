// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Video viewer for video-type KB documents (multimodal pipeline).
 *
 * Mirrors MultimodalImagePreview, but instead of fetching an authenticated
 * blob, it resolves a browser-reachable OSS signed URL via the
 * video-play-url endpoint (downloadlink API on the backend). The
 * <video> element then reaches OSS directly — the backend proxies no
 * bytes.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { isVideoExtension } from '@/apis/attachments'
import { getToken } from '@/apis/user'
import { useTranslation } from '@/hooks/useTranslation'

/**
 * Detect if a document is a video-type multimodal document.
 * document.file_extension is stored dot-less (e.g. "mp4"), while
 * isVideoExtension expects a leading dot — normalize before checking.
 */
export function isVideoDocument(
  document: { file_extension?: string; attachment_id?: number | null } | null | undefined
): boolean {
  if (!document || !document.attachment_id) return false
  const ext = document.file_extension?.trim().toLowerCase() || ''
  const dottedExt = ext.startsWith('.') ? ext : `.${ext}`
  return isVideoExtension(dottedExt)
}

interface PlayUrlResponse {
  url: string
  mime_type?: string
}

/** Resolve the signed CDN play URL ONCE (stable, no re-fetch on re-render). */
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
          signal: controller.signal,
        })
        if (!response.ok) {
          // 409 = video exists but not playable yet (transcoding in progress).
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
    resolve()
    return () => {
      isMounted = false
      controller.abort()
    }
  }, [documentId, enabled, requestVersion])

  return { playUrl, mimeType, isLoading, notReady, hasError, retry }
}

/**
 * Inline video preview for video-type documents.
 * Renders a <video> bound to the resolved signed CDN URL with native controls.
 */
export function MultimodalVideoPreview({
  documentId,
  name,
  startSec,
  endSec,
}: {
  documentId: number
  name: string
  startSec?: number
  endSec?: number
}) {
  const { t } = useTranslation('knowledge')
  const { playUrl, mimeType, isLoading, notReady, hasError, retry } = useVideoPlayUrl(
    documentId,
    true
  )
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video || startSec === undefined) return
    const seek = () => {
      video.currentTime = startSec
    }
    video.addEventListener('loadedmetadata', seek)
    return () => video.removeEventListener('loadedmetadata', seek)
  }, [playUrl, startSec])

  const handleTimeUpdate = () => {
    const video = videoRef.current
    if (video && endSec !== undefined && video.currentTime >= endSec) {
      video.pause()
    }
  }

  if (isLoading) {
    return (
      <div
        className="flex items-center justify-center bg-surface animate-pulse rounded-lg"
        style={{ minWidth: 200, minHeight: 120 }}
        data-testid="multimodal-video-preview-loading"
      >
        <Spinner />
      </div>
    )
  }

  if (notReady) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 bg-surface rounded-lg border border-border text-xs text-text-muted p-4">
        <AlertCircle className="h-4 w-4" />
        <span>{t('document.multimodal.videoPreview.notReady')}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={retry}
          data-testid="video-preview-retry"
        >
          {t('document.multimodal.videoPreview.retry')}
        </Button>
      </div>
    )
  }

  if (!playUrl) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 bg-surface rounded-lg border border-border text-xs text-text-muted p-4">
        <AlertCircle className="h-4 w-4" />
        <span>{hasError ? t('document.multimodal.videoPreview.loadFailed') : name}</span>
        {hasError && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={retry}
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
      onTimeUpdate={handleTimeUpdate}
      className="rounded-lg border border-border max-h-[600px] max-w-full bg-black"
      data-testid="multimodal-video-preview"
    >
      <source src={playUrl} type={mimeType} />
    </video>
  )
}
