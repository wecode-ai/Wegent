// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import dynamic from 'next/dynamic'
import { FileText, Film, ImageIcon, Play, Presentation, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { useTranslation } from '@/hooks/useTranslation'
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
    return <DocumentLinkCover key={resource.key} resource={resource} onOpen={onOpen} />
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
        {children || resource.label}
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-text-muted">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
        {t('document.document.detail.linkPreview.previewOnly')}
      </span>
    </button>
  )
}

type CoverState =
  | { status: 'idle' | 'loading' | 'error' }
  | {
      status: 'ready'
      blob?: Blob
      remoteUrl?: string
      objectUrl?: string
      text?: string
    }

function DocumentLinkCover({ resource, onOpen }: Omit<DocumentLinkResourceProps, 'children'>) {
  const { t } = useTranslation('knowledge')
  const containerRef = useRef<HTMLDivElement>(null)
  const startedRef = useRef(false)
  const [nearViewport, setNearViewport] = useState(false)
  const [coverState, setCoverState] = useState<CoverState>({ status: 'idle' })
  const Icon = icons[resource.kindHint]

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
    if (!nearViewport || startedRef.current) return
    startedRef.current = true
    setCoverState({ status: 'loading' })
    const controller = new AbortController()
    let objectUrl: string | undefined

    const loadCover = async () => {
      if (resource.kindHint === 'video') {
        await probeRemoteVideo(resource.url, controller.signal)
        if (!controller.signal.aborted) setCoverState({ status: 'ready' })
        return
      }
      if (resource.kindHint === 'pdf') {
        const result = await prepareRemotePdf(resource.url, controller.signal, resource.filename)
        if (!result.blob && !result.validatedUrl) throw new Error('PDF source was not validated')
        if (!controller.signal.aborted) {
          setCoverState({
            status: 'ready',
            blob: result.blob,
            remoteUrl: result.validatedUrl,
          })
        }
        return
      }

      const result = await loadBoundedRemoteFile(
        resource.url,
        resource.kindHint as 'office' | 'image' | 'text',
        controller.signal,
        resource.filename
      )
      if (controller.signal.aborted) return
      if (resource.kindHint === 'image') objectUrl = URL.createObjectURL(result.blob)
      const text = resource.kindHint === 'text' ? await result.blob.text() : undefined
      if (!controller.signal.aborted) {
        setCoverState({ status: 'ready', blob: result.blob, objectUrl, text })
      }
    }

    void loadCover().catch(() => {
      if (!controller.signal.aborted) setCoverState({ status: 'error' })
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
          {coverState.status === 'ready' && resource.kindHint === 'pdf' && (
            <div className="pointer-events-none h-full select-none" aria-hidden="true">
              <FlyfishOfficePreview
                blob={coverState.blob}
                url={coverState.remoteUrl}
                validatedRemotePdf={!!coverState.remoteUrl}
                filename={resource.filename}
                restricted
                coverOnly
                onError={() => setCoverState({ status: 'error' })}
              />
            </div>
          )}
          {coverState.status === 'ready' && resource.kindHint === 'office' && (
            <div className="pointer-events-none h-full select-none" aria-hidden="true">
              <FlyfishOfficePreview
                blob={coverState.blob}
                filename={resource.filename}
                restricted
                coverOnly
                onError={() => setCoverState({ status: 'error' })}
              />
            </div>
          )}
          {coverState.status === 'ready' &&
            resource.kindHint === 'image' &&
            coverState.objectUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={coverState.objectUrl}
                alt=""
                draggable={false}
                className="h-full w-full select-none object-contain"
                onContextMenu={event => event.preventDefault()}
                onError={() => setCoverState({ status: 'error' })}
                data-testid="document-link-image-cover"
              />
            )}
          {coverState.status === 'ready' &&
            resource.kindHint === 'text' &&
            coverState.text !== undefined && (
              <pre className="h-full overflow-hidden whitespace-pre-wrap break-words p-6 text-left font-mono text-xs leading-5 text-text-secondary">
                {coverState.text}
              </pre>
            )}
          {coverState.status === 'ready' && resource.kindHint === 'video' && (
            <video
              src={resource.url}
              preload="metadata"
              muted
              playsInline
              disablePictureInPicture
              controlsList="nodownload noremoteplayback"
              className="h-full w-full object-cover"
              onContextMenu={event => event.preventDefault()}
              onError={() => setCoverState({ status: 'error' })}
              aria-hidden="true"
              data-testid="document-link-video-cover"
            />
          )}
          {coverState.status === 'ready' && resource.kindHint === 'video' && (
            <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-black/60 text-white shadow-lg">
                <Play className="ml-1 h-8 w-8 fill-current" />
              </span>
            </span>
          )}
          {coverState.status === 'idle' && (
            <div className="flex h-full items-center justify-center text-text-muted">
              <Icon className="h-8 w-8" aria-hidden="true" />
            </div>
          )}
          {coverState.status === 'loading' && (
            <div className="flex h-full items-center justify-center">
              <Spinner text={t('document.document.detail.linkPreview.loading')} />
            </div>
          )}
          {coverState.status === 'error' && (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-text-muted">
              <Icon className="h-8 w-8" aria-hidden="true" />
              {t('document.document.detail.linkPreview.coverUnavailable')}
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
