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

import React, { useState, useCallback } from 'react'
import Image from 'next/image'
import { Download, Maximize2, X, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'

export interface ImageItem {
  url: string
  attachmentId?: number
  size?: string
}

export interface ImageGalleryProps {
  images: ImageItem[]
  className?: string
}

export function ImageGallery({ images, className }: ImageGalleryProps) {
  const { t } = useTranslation('chat')
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)

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

  // Handle keyboard navigation in lightbox
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (selectedIndex === null) return

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
    },
    [selectedIndex, images.length]
  )

  if (!images || images.length === 0) {
    return null
  }

  return (
    <>
      {/* Image Grid */}
      <div className={cn('flex flex-wrap gap-2', className)}>
        {images.map((image, index) => (
          <div
            key={`${image.url}-${index}`}
            className="relative group rounded-lg overflow-hidden cursor-pointer w-48 h-48"
            onClick={() => setSelectedIndex(index)}
          >
            {/* Image thumbnail using Next.js Image */}
            <Image
              src={image.url}
              alt={`${t('image.generated_image', 'Generated image')} ${index + 1}`}
              fill
              sizes="192px"
              className="object-cover transition-transform duration-200 group-hover:scale-105"
              unoptimized // Use unoptimized for external URLs
            />

            {/* Hover overlay with actions */}
            <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center gap-2">
              {/* Download button - 44px touch target */}
              <button
                type="button"
                onClick={e => handleDownload(image.url, index, e)}
                className="h-11 w-11 min-w-[44px] flex items-center justify-center rounded-full bg-white/20 hover:bg-white/30 transition-colors"
                title={t('image.download', 'Download image')}
              >
                <Download className="h-5 w-5 text-white" />
              </button>

              {/* Expand button - 44px touch target */}
              <button
                type="button"
                className="h-11 w-11 min-w-[44px] flex items-center justify-center rounded-full bg-white/20 hover:bg-white/30 transition-colors"
                title={t('image.expand', 'View full size')}
              >
                <Maximize2 className="h-5 w-5 text-white" />
              </button>
            </div>

            {/* Image size badge (if available) */}
            {image.size && (
              <div className="absolute bottom-2 left-2 px-2 py-1 rounded bg-black/60 text-white text-xs">
                {image.size}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Lightbox Modal */}
      {selectedIndex !== null && (
        <div
          className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center"
          onClick={() => setSelectedIndex(null)}
          onKeyDown={handleKeyDown}
          tabIndex={0}
          role="dialog"
          aria-modal="true"
          aria-label={t('image.lightbox', 'Image preview')}
        >
          {/* Close button - 44px touch target */}
          <button
            type="button"
            className="absolute top-4 right-4 h-11 w-11 min-w-[44px] flex items-center justify-center rounded-full bg-white/20 hover:bg-white/30 transition-colors z-10"
            onClick={() => setSelectedIndex(null)}
            title={t('common:actions.close', 'Close')}
          >
            <X className="h-6 w-6 text-white" />
          </button>

          {/* Download button in lightbox - 44px touch target */}
          <button
            type="button"
            className="absolute top-4 right-20 h-11 w-11 min-w-[44px] flex items-center justify-center rounded-full bg-white/20 hover:bg-white/30 transition-colors z-10"
            onClick={e => handleDownload(images[selectedIndex].url, selectedIndex, e)}
            title={t('image.download', 'Download image')}
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
            >
              <ChevronRight className="h-6 w-6 text-white" />
            </button>
          )}

          {/* Main image in lightbox - using regular img for full-size preview */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={images[selectedIndex].url}
            alt={`${t('image.generated_image', 'Generated image')} ${selectedIndex + 1}`}
            className="max-w-[90vw] max-h-[90vh] object-contain"
            onClick={e => e.stopPropagation()}
          />

          {/* Image counter */}
          {images.length > 1 && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-black/60 text-white text-sm">
              {selectedIndex + 1} / {images.length}
            </div>
          )}
        </div>
      )}
    </>
  )
}

export default ImageGallery
