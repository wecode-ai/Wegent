// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Video viewer for video-type KB documents (multimodal pipeline).
 *
 * Mirrors MultimodalImagePreview, but instead of fetching an authenticated
 * blob, it resolves a browser-reachable signed CDN URL via the
 * video-play-url endpoint (show_batch + get_ssig_url on the backend). The
 * <video> element then reaches Weibo CDN directly — the backend proxies no
 * bytes. The stored fid doubles as the media_id (verified empirically).
 */

import { useEffect, useRef, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { isVideoExtension } from '@/apis/attachments'
import { getToken } from '@/apis/user'

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
  cover_url?: string | null
  duration?: number | null
  mime_type?: string
}

/** Resolve the signed CDN play URL ONCE (stable, no re-fetch on re-render). */
export function useVideoPlayUrl(
  documentId: number,
  enabled: boolean
): {
  playUrl: string | null
  coverUrl: string | null
  mimeType: string
  isLoading: boolean
  notReady: boolean
} {
  const [playUrl, setPlayUrl] = useState<string | null>(null)
  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  const [mimeType, setMimeType] = useState('video/mp4')
  const [isLoading, setIsLoading] = useState(enabled)
  const [notReady, setNotReady] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let isMounted = true
    const resolve = async () => {
      setIsLoading(true)
      setNotReady(false)
      try {
        const token = getToken()
        const response = await fetch(`/api/knowledge-documents/${documentId}/video-play-url`, {
          method: 'GET',
          headers: { ...(token && { Authorization: `Bearer ${token}` }) },
        })
        if (!response.ok) {
          // 409 = video exists but not playable yet (transcoding in progress).
          if (response.status === 409 && isMounted) setNotReady(true)
          throw new Error(`Failed to resolve video URL: ${response.status}`)
        }
        const data = (await response.json()) as PlayUrlResponse
        if (isMounted) {
          setPlayUrl(data.url)
          setCoverUrl(data.cover_url ?? null)
          setMimeType(data.mime_type ?? 'video/mp4')
        }
      } catch {
        // Error state is reflected by playUrl staying null after loading.
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }
    resolve()
    return () => {
      isMounted = false
    }
  }, [documentId, enabled])

  return { playUrl, coverUrl, mimeType, isLoading, notReady }
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
  const { playUrl, coverUrl, mimeType, isLoading, notReady } = useVideoPlayUrl(documentId, true)
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
      <div className="flex items-center justify-center gap-2 bg-surface rounded-lg border border-border text-xs text-text-muted p-4">
        <AlertCircle className="h-4 w-4" />
        <span>视频转码中，请稍后重试</span>
      </div>
    )
  }

  if (!playUrl) {
    return (
      <div className="flex items-center justify-center gap-2 bg-surface rounded-lg border border-border text-xs text-text-muted p-4">
        <AlertCircle className="h-4 w-4" />
        <span>{name}</span>
      </div>
    )
  }

  return (
    <video
      ref={videoRef}
      src={playUrl}
      poster={coverUrl ?? undefined}
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
