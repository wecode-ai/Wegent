// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * ImageGallery Component
 *
 * A component for displaying generated images in a grid layout.
 * Features:
 * - Grid display of images
 * - Hover actions (download, expand)
 * - Lightbox preview with click
 * - Touch-friendly for mobile (44px minimum touch targets)
 */

'use client'

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import Image from 'next/image'
import { Download, X, ChevronLeft, ChevronRight, ImagePlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { resolveGeneratedImageDisplayLayout } from '@/features/tasks/utils/imageDisplaySize'

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

export function ImageGallery({
  images,
  imageSize,
  className,
  onUseAsReference,
}: ImageGalleryProps) {
  const { t } = useTranslation('chat')
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

  // Handle image download
  const handleDownload = useCallback(async (url: string, index: number, e?: React.MouseEvent) => {
    e?.stopPropagation()

    try {
      // Fetch the image as blob to handle CORS
      const response = await fetch(url)
      const blob = await response.blob()
      const blobUrl = URL.createObjectURL(blob)

      const link = document.createElement('a')
      link.href = blobUrl
      link.download = `generated_image_${index + 1}.jpg`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)

      // Clean up blob URL
      URL.revokeObjectURL(blobUrl)
    } catch {
      // Fallback: open in new tab if download fails
      window.open(url, '_blank')
    }
  }, [])

  // Navigate to previous image in lightbox
  const handlePrevious = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (selectedIndex !== null && selectedIndex > 0) {
        setSelectedIndex(selectedIndex - 1)
      }
    },
    [selectedIndex]
  )

  // Navigate to next image in lightbox
  const handleNext = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (selectedIndex !== null && selectedIndex < images.length - 1) {
        setSelectedIndex(selectedIndex + 1)
      }
    },
    [selectedIndex, images.length]
  )

  useEffect(() => {
    if (selectedIndex === null) return

    const previousOverflow = document.body.style.overflow
    const trigger = thumbnailRefs.current[selectedIndex]
    document.body.style.overflow = 'hidden'
    lightboxRef.current?.focus()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (selectedIndex === null) return

      if (e.key === 'Tab' && lightboxRef.current) {
        const focusable = Array.from(
          lightboxRef.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
        )
        if (focusable.length > 0) {
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault()
            last.focus()
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }
        return
      }

      switch (e.key) {
        case 'ArrowLeft':
          if (selectedIndex > 0) {
            setSelectedIndex(selectedIndex - 1)
          }
          break
        case 'ArrowRight':
          if (selectedIndex < images.length - 1) {
            setSelectedIndex(selectedIndex + 1)
          }
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
  }, [selectedIndex, images.length])

  if (!images || images.length === 0) {
    return null
  }

  return (
    <>
      {/* Image Grid */}
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
                <Image
                  src={image.url}
                  alt={`${t('image.generated_image', 'Generated image')} ${index + 1}`}
                  fill
                  sizes="220px"
                  className="object-cover transition-transform duration-200 group-hover:scale-105"
                  unoptimized
                  ref={element => {
                    if (element?.complete) recordNaturalSize(index, element)
                  }}
                  onLoad={event => recordNaturalSize(index, event.currentTarget)}
                />
              </button>

              {/* Actions */}
              <div className="absolute top-2 right-2 flex items-center overflow-hidden rounded-lg bg-black/55 backdrop-blur-md shadow-sm opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity duration-200">
                {/* Use as reference button (shown only when callback provided) */}
                {onUseAsReference && image.attachmentId && (
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation()
                      onUseAsReference(image)
                    }}
                    className="h-11 w-11 sm:h-8 sm:w-8 flex items-center justify-center border-r border-white/20 hover:bg-white/15 transition-colors"
                    title={t('image.use_as_reference', 'Use as reference')}
                    data-testid={`generated-image-reference-${index}`}
                  >
                    <ImagePlus className="h-4 w-4 text-white" />
                  </button>
                )}

                <button
                  type="button"
                  onClick={e => handleDownload(image.url, index, e)}
                  className="h-11 w-11 sm:h-8 sm:w-8 flex items-center justify-center hover:bg-white/15 transition-colors"
                  title={t('image.download', 'Download image')}
                  data-testid={`generated-image-download-${index}`}
                >
                  <Download className="h-4 w-4 text-white" />
                </button>
              </div>

              {/* Image size badge (if available) */}
              {image.size && (
                <div className="absolute bottom-2 left-2 px-2 py-1 rounded bg-black/60 text-white text-xs">
                  {image.size}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Lightbox Modal */}
      {selectedIndex !== null &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={lightboxRef}
            className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => setSelectedIndex(null)}
            role="dialog"
            aria-modal="true"
            aria-label={t('image.lightbox', 'Image preview')}
            tabIndex={-1}
            data-testid="generated-image-lightbox"
          >
            {/* Close button - 44px touch target */}
            <button
              type="button"
              className="absolute top-4 right-4 h-11 w-11 min-w-[44px] flex items-center justify-center rounded-full bg-white/20 hover:bg-white/30 transition-colors z-10"
              onClick={() => setSelectedIndex(null)}
              title={t('common:actions.close', 'Close')}
              data-testid="generated-image-lightbox-close"
            >
              <X className="h-6 w-6 text-white" />
            </button>

            {/* Download button in lightbox - 44px touch target */}
            <button
              type="button"
              className="absolute top-4 right-20 h-11 w-11 min-w-[44px] flex items-center justify-center rounded-full bg-white/20 hover:bg-white/30 transition-colors z-10"
              onClick={e => handleDownload(images[selectedIndex].url, selectedIndex, e)}
              title={t('image.download', 'Download image')}
              data-testid="generated-image-lightbox-download"
            >
              <Download className="h-6 w-6 text-white" />
            </button>

            {/* Previous button - 44px touch target */}
            {selectedIndex > 0 && (
              <button
                type="button"
                className="absolute left-4 top-1/2 -translate-y-1/2 h-11 w-11 min-w-[44px] flex items-center justify-center rounded-full bg-white/20 hover:bg-white/30 transition-colors z-10"
                onClick={handlePrevious}
                title={t('common:common.previous', 'Previous')}
                data-testid="generated-image-lightbox-previous"
              >
                <ChevronLeft className="h-6 w-6 text-white" />
              </button>
            )}

            {/* Next button - 44px touch target */}
            {selectedIndex < images.length - 1 && (
              <button
                type="button"
                className="absolute right-4 top-1/2 -translate-y-1/2 h-11 w-11 min-w-[44px] flex items-center justify-center rounded-full bg-white/20 hover:bg-white/30 transition-colors z-10"
                onClick={handleNext}
                title={t('common:common.next', 'Next')}
                data-testid="generated-image-lightbox-next"
              >
                <ChevronRight className="h-6 w-6 text-white" />
              </button>
            )}

            {/* Main image in lightbox - using regular img for full-size preview */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={images[selectedIndex].url}
              alt={`${t('image.generated_image', 'Generated image')} ${selectedIndex + 1}`}
              className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
              onClick={e => e.stopPropagation()}
            />

            {/* Image counter */}
            {images.length > 1 && (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-black/60 text-white text-sm">
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
