// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import dynamic from 'next/dynamic'
import { FileText, Film, ImageIcon, Play, Presentation, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Spinner } from '@/components/ui/spinner'
import {
  loadBoundedRemoteFile,
  prepareRemotePdf,
  probeRemoteVideo,
} from '../utils/boundedRemoteFile'
import type { DocumentLinkResource as Resource } from '../utils/documentLinkResource'

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

const icons = {
  pdf: FileText,
  office: Presentation,
  video: Film,
  image: ImageIcon,
  text: FileText,
  unknown: FileText,
}

interface DocumentLinkResourceProps {
  resource: Resource
  children?: ReactNode
  onOpen: (resource: Resource) => void
  inline?: boolean
}

export function DocumentLinkResource({
  resource,
  children,
  onOpen,
  inline = false,
}: DocumentLinkResourceProps) {
  const { t } = useTranslation('knowledge')
  const Icon = icons[resource.kindHint]

  if (!inline && resource.kindHint !== 'unknown') {
    return <DocumentLinkCover resource={resource} onOpen={onOpen} />
  }

  return (
    <button
      type="button"
      className="mx-0.5 inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 align-middle text-primary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      onClick={() => onOpen(resource)}
      title={resource.label}
      data-testid="document-link-preview-trigger"
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className={inline ? 'min-w-0 break-all text-left' : 'max-w-[28rem] truncate'}>
        {inline ? (
          <>
            [{children || resource.label}]({resource.url})
          </>
        ) : (
          children || resource.label
        )}
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-text-muted">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
        {t('document.document.detail.linkPreview.previewOnly')}
      </span>
    </button>
  )
}

function DocumentLinkCover({ resource, onOpen }: Omit<DocumentLinkResourceProps, 'children'>) {
  const { t } = useTranslation('knowledge')
  const containerRef = useRef<HTMLDivElement>(null)
  const [nearViewport, setNearViewport] = useState(false)
  const [coverFailed, setCoverFailed] = useState(false)
  const [videoCoverEnabled, setVideoCoverEnabled] = useState(false)
  const [boundedCover, setBoundedCover] = useState<{
    blob?: Blob
    remoteUrl?: string
    objectUrl?: string
    text?: string
  } | null>(null)
  const Icon = icons[resource.kindHint]

  useEffect(() => {
    setCoverFailed(false)
    setVideoCoverEnabled(false)
    setBoundedCover(null)
  }, [resource.key])

  useEffect(() => {
    const element = containerRef.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setNearViewport(true)
      return
    }
    const observer = new IntersectionObserver(
      entries => {
        if (!entries.some(entry => entry.isIntersecting)) return
        setNearViewport(true)
        observer.disconnect()
      },
      { rootMargin: '240px' }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!nearViewport || resource.kindHint !== 'video') return
    const controller = new AbortController()
    void probeRemoteVideo(resource.url, controller.signal)
      .then(() => setVideoCoverEnabled(true))
      .catch(() => {
        if (!controller.signal.aborted) setVideoCoverEnabled(false)
      })
    return () => controller.abort()
  }, [nearViewport, resource.kindHint, resource.url])

  useEffect(() => {
    if (!nearViewport || !['pdf', 'office', 'image', 'text'].includes(resource.kindHint)) return
    const controller = new AbortController()
    let objectUrl: string | undefined
    const loadCover =
      resource.kindHint === 'pdf'
        ? prepareRemotePdf(resource.url, controller.signal, resource.filename)
        : loadBoundedRemoteFile(
            resource.url,
            resource.kindHint as 'office' | 'image' | 'text',
            controller.signal,
            resource.filename
          )
    void loadCover
      .then(async result => {
        objectUrl =
          resource.kindHint === 'image' && result.blob
            ? URL.createObjectURL(result.blob)
            : undefined
        const text = resource.kindHint === 'text' ? await result.blob?.text() : undefined
        if (!controller.signal.aborted) {
          setBoundedCover({
            blob: result.blob,
            remoteUrl: resource.kindHint === 'pdf' && !result.blob ? resource.url : undefined,
            objectUrl,
            text,
          })
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setCoverFailed(true)
      })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [nearViewport, resource.filename, resource.kindHint, resource.url])

  return (
    <div
      ref={containerRef}
      className={`my-4 overflow-hidden rounded-xl border border-border bg-white shadow-sm ${
        resource.kindHint === 'video' ? 'max-w-sm' : 'w-full max-w-4xl'
      }`}
      data-testid="document-link-preview-card"
    >
      <div className="flex min-h-11 items-center gap-2 border-b border-border px-4 py-2.5">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
            resource.kindHint === 'pdf' ? 'bg-red-500 text-white' : 'bg-primary/10 text-primary'
          }`}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
          {resource.label}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-text-muted">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          {t('document.document.detail.linkPreview.previewOnly')}
        </span>
      </div>

      <div className="relative">
        <div
          className={`relative overflow-hidden bg-gray-100 ${
            resource.kindHint === 'video' ? 'aspect-[3/4]' : 'h-72 sm:h-96'
          }`}
        >
          {nearViewport && resource.kindHint === 'pdf' && boundedCover && !coverFailed && (
            <div className="pointer-events-none h-full select-none" aria-hidden="true">
              <FlyfishOfficePreview
                blob={boundedCover.blob}
                url={boundedCover.remoteUrl}
                filename={resource.filename}
                restricted
                coverOnly
                onError={() => setCoverFailed(true)}
              />
            </div>
          )}
          {nearViewport && resource.kindHint === 'office' && boundedCover && !coverFailed && (
            <div className="pointer-events-none h-full select-none" aria-hidden="true">
              <FlyfishOfficePreview
                blob={boundedCover.blob}
                filename={resource.filename}
                restricted
                coverOnly
                onError={() => setCoverFailed(true)}
              />
            </div>
          )}
          {nearViewport &&
            resource.kindHint === 'image' &&
            boundedCover?.objectUrl &&
            !coverFailed && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={boundedCover.objectUrl}
                alt=""
                draggable={false}
                className="h-full w-full select-none object-contain"
                onContextMenu={event => event.preventDefault()}
                onError={() => setCoverFailed(true)}
                data-testid="document-link-image-cover"
              />
            )}
          {nearViewport &&
            resource.kindHint === 'text' &&
            boundedCover?.text !== undefined &&
            !coverFailed && (
              <pre className="h-full overflow-hidden whitespace-pre-wrap break-words p-6 text-left font-mono text-xs leading-5 text-text-secondary">
                {boundedCover.text}
              </pre>
            )}
          {nearViewport && resource.kindHint === 'video' && videoCoverEnabled && !coverFailed && (
            <video
              src={resource.url}
              preload="metadata"
              muted
              playsInline
              disablePictureInPicture
              controlsList="nodownload noremoteplayback"
              className="h-full w-full object-cover"
              onContextMenu={event => event.preventDefault()}
              onError={() => setCoverFailed(true)}
              aria-hidden="true"
            />
          )}
          {resource.kindHint === 'video' && (
            <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-black/60 text-white shadow-lg">
                <Play className="ml-1 h-8 w-8 fill-current" />
              </span>
            </span>
          )}
          {(!nearViewport ||
            coverFailed ||
            (['pdf', 'office', 'image', 'text'].includes(resource.kindHint) && !boundedCover)) && (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-text-muted">
              <Icon className="h-8 w-8" aria-hidden="true" />
              {coverFailed
                ? t('document.document.detail.linkPreview.coverUnavailable')
                : t('document.document.detail.linkPreview.loading')}
            </div>
          )}
        </div>
        <div className="flex min-h-14 items-center justify-center bg-white px-4 py-3 text-sm font-medium text-text-primary">
          {t('document.document.detail.linkPreview.viewOnline')}
        </div>
        <button
          type="button"
          className="absolute inset-0 rounded-b-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
          onClick={() => onOpen(resource)}
          title={t('document.document.detail.linkPreview.viewOnline')}
          data-testid="document-link-preview-trigger"
        >
          <span className="sr-only">
            {t('document.document.detail.linkPreview.viewOnline')}: {resource.label}
          </span>
        </button>
      </div>
    </div>
  )
}
