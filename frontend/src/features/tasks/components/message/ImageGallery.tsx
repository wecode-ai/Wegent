// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * ImageGallery Component
 *
 * A component for displaying generated images in a grid layout.
 * Features:
 * - Grid display of images
 * - Hover actions (download and use as reference)
 * - Lightbox preview with keyboard navigation
 * - Touch-friendly for mobile (44px minimum touch targets)
 */

'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Image from 'next/image'
import { ChevronLeft, ChevronRight, Download, ImagePlus, Loader2, X } from 'lucide-react'

import { downloadAttachment } from '@/apis/attachments'
import { useShareToken } from '@/contexts/ShareTokenContext'
import { resolveGeneratedImageDisplayLayout } from '@/features/tasks/utils/imageDisplaySize'
import { useAttachmentImage } from '@/hooks/useAttachmentImage'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

export interface ImageItem {
  url: string
  attachmentId?: number
  size?: string
}

export interface ImageGalleryProps {
  images: ImageItem[]
  imageSize?: string
  className?: string
  /** Optional callback when user wants to use an image as reference for follow-up generation */
  onUseAsReference?: (item: ImageItem) => void
}

interface GalleryImageProps {
  image: ImageItem
  index: number
  onLoad: (image: HTMLImageElement) => void
}

function GalleryImage({ image, index, onLoad }: GalleryImageProps) {
  const { t } = useTranslation('chat')
  const { shareToken } = useShareToken()
  const hasAttachment = typeof image.attachmentId === 'number'
  const { blobUrl, isLoading } = useAttachmentImage(
    image.attachmentId ?? 0,
    hasAttachment,
    shareToken
  )
  const displayUrl = hasAttachment ? blobUrl : image.url

  if (!displayUrl) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-muted">
        {isLoading ? <Loader2 className="h-6 w-6 animate-spin text-text-muted" /> : null}
      </div>
    )
  }

  return (
    <Image
      src={displayUrl}
      alt={`${t('image.generated_image', 'Generated image')} ${index + 1}`}
      fill
      sizes="220px"
      className="object-cover transition-transform duration-200 group-hover:scale-105"
      unoptimized
      onLoad={event => onLoad(event.currentTarget)}
    />
  )
}

function LightboxImage({ image, index }: { image: ImageItem; index: number }) {
  const { t } = useTranslation('chat')
  const { shareToken } = useShareToken()
  const hasAttachment = typeof image.attachmentId === 'number'
  const { blobUrl, isLoading } = useAttachmentImage(
    image.attachmentId ?? 0,
    hasAttachment,
    shareToken
  )
  const displayUrl = hasAttachment ? blobUrl : image.url

  if (!displayUrl) {
    return isLoading ? <Loader2 className="h-8 w-8 animate-spin text-white" /> : null
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={displayUrl}
      alt={`${t('image.generated_image', 'Generated image')} ${index + 1}`}
      className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
      onClick={event => event.stopPropagation()}
    />
  )
}

export function ImageGallery({
  images,
  imageSize,
  className,
  onUseAsReference,
}: ImageGalleryProps) {
  const { t } = useTranslation('chat')
  const { shareToken } = useShareToken()
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [naturalSizes, setNaturalSizes] = useState<Record<number, string>>({})
  const lightboxRef = useRef<HTMLDivElement>(null)
  const thumbnailRefs = useRef<Array<HTMLButtonElement | null>>([])

  const recordNaturalSize = useCallback((index: number, image: HTMLImageElement) => {
    const { naturalWidth, naturalHeight } = image
    if (naturalWidth <= 0 || naturalHeight <= 0) return

    const naturalSize = `${naturalWidth}x${naturalHeight}`
    setNaturalSizes(previous =>
      previous[index] === naturalSize ? previous : { ...previous, [index]: naturalSize }
    )
  }, [])

  const handleDownload = useCallback(
    async (image: ImageItem, index: number, event?: React.MouseEvent) => {
      event?.stopPropagation()

      try {
        if (typeof image.attachmentId === 'number') {
          await downloadAttachment(
            image.attachmentId,
            `generated_image_${index + 1}.jpg`,
            shareToken
          )
          return
        }

        const response = await fetch(image.url)
        const blob = await response.blob()
        const blobUrl = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = blobUrl
        link.download = `generated_image_${index + 1}.jpg`
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(blobUrl)
      } catch {
        window.open(image.url, '_blank')
      }
    },
    [shareToken]
  )

  const handlePrevious = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation()
      if (selectedIndex !== null && selectedIndex > 0) {
        setSelectedIndex(selectedIndex - 1)
      }
    },
    [selectedIndex]
  )

  const handleNext = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation()
      if (selectedIndex !== null && selectedIndex < images.length - 1) {
        setSelectedIndex(selectedIndex + 1)
      }
    },
    [images.length, selectedIndex]
  )

  useEffect(() => {
    if (selectedIndex === null) return

    const previousOverflow = document.body.style.overflow
    const trigger = thumbnailRefs.current[selectedIndex]
    document.body.style.overflow = 'hidden'
    lightboxRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab' && lightboxRef.current) {
        const focusable = Array.from(
          lightboxRef.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
        )
        if (focusable.length > 0) {
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        return
      }

      switch (event.key) {
        case 'ArrowLeft':
          if (selectedIndex > 0) setSelectedIndex(selectedIndex - 1)
          break
        case 'ArrowRight':
          if (selectedIndex < images.length - 1) setSelectedIndex(selectedIndex + 1)
          break
        case 'Escape':
          setSelectedIndex(null)
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      trigger?.focus()
    }
  }, [images.length, selectedIndex])

  if (!images || images.length === 0) {
    return null
  }

  return (
    <>
      <div className={cn('flex flex-wrap gap-2', className)}>
        {images.map((image, index) => {
          const declaredSize = image.size || imageSize
          const hasValidDeclaredSize =
            typeof declaredSize === 'string' &&
            /^\d+(?:\.\d+)?\s*x\s*\d+(?:\.\d+)?$/i.test(declaredSize.trim())
          const displayLayout = resolveGeneratedImageDisplayLayout(
            hasValidDeclaredSize ? declaredSize : naturalSizes[index]
          )

          return (
            <div
              key={`${image.url}-${index}`}
              className="group relative flex-none overflow-hidden rounded-lg"
              style={displayLayout}
              data-testid={`generated-image-preview-${index}`}
            >
              <button
                type="button"
                ref={element => {
                  thumbnailRefs.current[index] = element
                }}
                className="absolute inset-0 overflow-hidden rounded-lg"
                onClick={() => setSelectedIndex(index)}
                aria-label={`${t('image.lightbox', 'Image preview')} ${index + 1}`}
                data-testid={`generated-image-open-${index}`}
              >
                <GalleryImage
                  image={image}
                  index={index}
                  onLoad={loadedImage => recordNaturalSize(index, loadedImage)}
                />
              </button>

              <div className="absolute top-2 right-2 flex items-center overflow-hidden rounded-lg bg-black/55 opacity-100 shadow-sm backdrop-blur-md transition-opacity duration-200 sm:opacity-0 sm:group-hover:opacity-100">
                {onUseAsReference && typeof image.attachmentId === 'number' && (
                  <button
                    type="button"
                    onClick={event => {
                      event.stopPropagation()
                      onUseAsReference(image)
                    }}
                    className="flex h-11 w-11 items-center justify-center border-r border-white/20 transition-colors hover:bg-white/15 sm:h-8 sm:w-8"
                    title={t('image.use_as_reference', 'Use as reference')}
                    data-testid={`generated-image-reference-${index}`}
                  >
                    <ImagePlus className="h-4 w-4 text-white" />
                  </button>
                )}

                <button
                  type="button"
                  onClick={event => handleDownload(image, index, event)}
                  className="flex h-11 w-11 items-center justify-center transition-colors hover:bg-white/15 sm:h-8 sm:w-8"
                  title={t('image.download', 'Download image')}
                  data-testid={`generated-image-download-${index}`}
                >
                  <Download className="h-4 w-4 text-white" />
                </button>
              </div>

              {image.size && (
                <div className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 text-xs text-white">
                  {image.size}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {selectedIndex !== null &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={lightboxRef}
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
            onClick={() => setSelectedIndex(null)}
            role="dialog"
            aria-modal="true"
            aria-label={t('image.lightbox', 'Image preview')}
            tabIndex={-1}
            data-testid="generated-image-lightbox"
          >
            <button
              type="button"
              className="absolute top-4 right-4 z-10 flex h-11 w-11 min-w-[44px] items-center justify-center rounded-full bg-white/20 transition-colors hover:bg-white/30"
              onClick={() => setSelectedIndex(null)}
              title={t('common:actions.close', 'Close')}
              data-testid="generated-image-lightbox-close"
            >
              <X className="h-6 w-6 text-white" />
            </button>

            <button
              type="button"
              className="absolute top-4 right-20 z-10 flex h-11 w-11 min-w-[44px] items-center justify-center rounded-full bg-white/20 transition-colors hover:bg-white/30"
              onClick={event => handleDownload(images[selectedIndex], selectedIndex, event)}
              title={t('image.download', 'Download image')}
              data-testid="generated-image-lightbox-download"
            >
              <Download className="h-6 w-6 text-white" />
            </button>

            {selectedIndex > 0 && (
              <button
                type="button"
                className="absolute top-1/2 left-4 z-10 flex h-11 w-11 min-w-[44px] -translate-y-1/2 items-center justify-center rounded-full bg-white/20 transition-colors hover:bg-white/30"
                onClick={handlePrevious}
                title={t('common:common.previous', 'Previous')}
                data-testid="generated-image-lightbox-previous"
              >
                <ChevronLeft className="h-6 w-6 text-white" />
              </button>
            )}

            {selectedIndex < images.length - 1 && (
              <button
                type="button"
                className="absolute top-1/2 right-4 z-10 flex h-11 w-11 min-w-[44px] -translate-y-1/2 items-center justify-center rounded-full bg-white/20 transition-colors hover:bg-white/30"
                onClick={handleNext}
                title={t('common:common.next', 'Next')}
                data-testid="generated-image-lightbox-next"
              >
                <ChevronRight className="h-6 w-6 text-white" />
              </button>
            )}

            <LightboxImage image={images[selectedIndex]} index={selectedIndex} />

            {images.length > 1 && (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-4 py-2 text-sm text-white">
                {selectedIndex + 1} / {images.length}
              </div>
            )}
          </div>,
          document.body
        )}
    </>
  )
}

export default ImageGallery
