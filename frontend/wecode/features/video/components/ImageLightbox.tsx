// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * ImageLightbox Component for Video Module
 *
 * A lightweight image preview modal for the video feature.
 * Features:
 * - Full screen image display
 * - Click backdrop to close
 * - ESC key to close
 * - Portal-based rendering (avoids z-index issues)
 */

'use client'

import React, { useState, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { ArrowLeftIcon, ArrowRightIcon } from './ActionIcons'

interface ImageLightboxProps {
  /** Image URL to display */
  src: string
  /** Alt text for accessibility */
  alt?: string
  /** Whether the lightbox is open */
  isOpen: boolean
  /** Callback when lightbox is closed */
  onClose: () => void
  /** Callback to navigate to the previous image */
  onPrev?: () => void
  /** Callback to navigate to the next image */
  onNext?: () => void
  /** Whether the previous button should be shown */
  hasPrev?: boolean
  /** Whether the next button should be shown */
  hasNext?: boolean
  /** Current image index */
  currentIndex?: number
  /** Total image count */
  totalImages?: number
  /** Lightbox title */
  title?: string
  /** Test id for the lightbox container */
  testId?: string
  /** Custom close button aria label */
  closeAriaLabel?: string
  /** Custom previous button aria label */
  prevAriaLabel?: string
  /** Custom next button aria label */
  nextAriaLabel?: string
}

/**
 * Full screen image lightbox component
 * Renders via portal to document.body to avoid z-index and overflow issues
 */
export function ImageLightbox({
  src,
  alt = '',
  isOpen,
  onClose,
  onPrev,
  onNext,
  hasPrev = false,
  hasNext = false,
  currentIndex,
  totalImages,
  title,
  testId,
  closeAriaLabel = 'Close',
  prevAriaLabel = 'Previous image',
  nextAriaLabel = 'Next image',
}: ImageLightboxProps) {
  const [isMounted, setIsMounted] = useState(false)

  // Client-side mount check for portal
  useEffect(() => {
    setIsMounted(true)
  }, [])

  // Handle keyboard events
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          e.stopPropagation()
          onClose()
          break
        case 'ArrowLeft':
          if (hasPrev && onPrev) {
            e.stopPropagation()
            onPrev()
          }
          break
        case 'ArrowRight':
          if (hasNext && onNext) {
            e.stopPropagation()
            onNext()
          }
          break
      }
    }

    // Use capture phase and document to ensure listener fires before parent's listener
    document.addEventListener('keydown', handleKeyDown, true)
    // Prevent body scroll when lightbox is open
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      document.body.style.overflow = ''
    }
  }, [hasNext, hasPrev, isOpen, onClose, onNext, onPrev])

  // Handle backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose()
      }
    },
    [onClose]
  )

  // Lightbox content
  const lightboxContent = isOpen ? (
    <div
      data-testid={testId}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/90 backdrop-blur-sm"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
    >
      {title ? (
        <div className="absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-full bg-black/50 px-4 py-2 text-sm text-white">
          {title}
        </div>
      ) : null}

      {/* Close button - positioned lower on mobile to avoid overlap with panel header */}
      <button
        type="button"
        onClick={e => {
          e.stopPropagation()
          onClose()
        }}
        className="fixed top-16 sm:top-4 right-4 h-11 w-11 min-w-[44px] flex items-center justify-center rounded-full bg-white/20 hover:bg-white/30 active:bg-white/40 transition-colors z-[10000] pointer-events-auto"
        aria-label={closeAriaLabel}
        style={{ touchAction: 'manipulation' }}
      >
        <X className="h-6 w-6 text-white pointer-events-none" />
      </button>

      {hasPrev && onPrev ? (
        <button
          type="button"
          className="absolute left-4 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white shadow-[0_2px_8.75px_0_rgba(160,160,160,0.25)] transition-shadow active:shadow-[0_1px_4px_0_rgba(160,160,160,0.25)] focus-visible:outline-none [@media(hover:hover)]:hover:shadow-[0_2px_8.75px_0_rgba(160,160,160,0.35)]"
          onClick={e => {
            e.stopPropagation()
            onPrev()
          }}
          aria-label={prevAriaLabel}
          title="Previous (←)"
        >
          <ArrowLeftIcon className="h-6 w-6 text-text-primary" />
        </button>
      ) : null}

      {hasNext && onNext ? (
        <button
          type="button"
          className="absolute right-4 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white shadow-[0_2px_8.75px_0_rgba(160,160,160,0.25)] transition-shadow active:shadow-[0_1px_4px_0_rgba(160,160,160,0.25)] focus-visible:outline-none [@media(hover:hover)]:hover:shadow-[0_2px_8.75px_0_rgba(160,160,160,0.35)]"
          onClick={e => {
            e.stopPropagation()
            onNext()
          }}
          aria-label={nextAriaLabel}
          title="Next (→)"
        >
          <ArrowRightIcon className="h-6 w-6 text-text-primary" />
        </button>
      ) : null}

      {/* Main image */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className="max-w-[90vw] max-h-[90vh] object-contain cursor-default"
        onClick={e => e.stopPropagation()}
      />

      {totalImages && totalImages > 1 && currentIndex !== undefined ? (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-black/50 px-4 py-2 text-sm text-white">
          {currentIndex + 1} / {totalImages}
        </div>
      ) : null}
    </div>
  ) : null

  // Render via portal
  if (!isMounted || !lightboxContent) return null

  return createPortal(lightboxContent, document.body)
}

export default ImageLightbox
