// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useState, useEffect } from 'react'
import { Download, X, ZoomIn, ZoomOut, RotateCw, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  formatFileSize,
  getFileIcon,
  downloadAttachment,
  isImageExtension,
  getAttachmentPreviewUrl,
} from '@/apis/attachments'
import { getToken } from '@/apis/user'
import type { Attachment } from '@/types/api'

interface AttachmentPreviewProps {
  /** Attachment data */
  attachment: Attachment
  /** Whether to show download button */
  showDownload?: boolean
  /** Compact mode (smaller size) */
  compact?: boolean
}

/**
 * Full screen image preview modal component
 */
function ImageLightbox({
  src,
  alt,
  onClose,
  onDownload,
}: {
  src: string
  alt: string
  onClose: () => void
  onDownload: () => void
}) {
  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0)

  const handleZoomIn = useCallback(() => {
    setScale(prev => Math.min(prev + 0.25, 3))
  }, [])

  const handleZoomOut = useCallback(() => {
    setScale(prev => Math.max(prev - 0.25, 0.5))
  }, [])

  const handleRotate = useCallback(() => {
    setRotation(prev => (prev + 90) % 360)
  }, [])

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose()
      }
    },
    [onClose]
  )

  // Handle keyboard events
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose()
          break
        case '+':
        case '=':
          handleZoomIn()
          break
        case '-':
          handleZoomOut()
          break
        case 'r':
        case 'R':
          handleRotate()
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    // Prevent body scroll when lightbox is open
    document.body.style.overflow = 'hidden'

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [onClose, handleZoomIn, handleZoomOut, handleRotate])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      {/* Toolbar */}
      <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleZoomOut}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title="缩小 (-)"
        >
          <ZoomOut className="h-5 w-5" />
        </Button>
        <span className="text-white text-sm bg-black/50 px-2 py-1 rounded">
          {Math.round(scale * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleZoomIn}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title="放大 (+)"
        >
          <ZoomIn className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleRotate}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title="旋转 (R)"
        >
          <RotateCw className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onDownload}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title="下载"
        >
          <Download className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title="关闭 (Esc)"
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      {/* Image container */}
      <div className="max-w-[90vw] max-h-[90vh] overflow-auto">
        <img
          src={src}
          alt={alt}
          className="transition-transform duration-200 ease-out"
          style={{
            transform: `scale(${scale}) rotate(${rotation}deg)`,
            maxWidth: scale === 1 ? '90vw' : 'none',
            maxHeight: scale === 1 ? '90vh' : 'none',
          }}
          draggable={false}
        />
      </div>

      {/* Filename at bottom */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white text-sm bg-black/50 px-4 py-2 rounded-lg">
        {alt}
      </div>
    </div>
  )
}

/**
 * Custom hook to fetch image with authentication and return blob URL
 */
function useAuthenticatedImage(attachmentId: number, isImage: boolean) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!isImage) return

    let isMounted = true
    const fetchImage = async () => {
      setIsLoading(true)
      setError(false)

      try {
        const token = getToken()
        const response = await fetch(getAttachmentPreviewUrl(attachmentId), {
          headers: {
            ...(token && { Authorization: `Bearer ${token}` }),
          },
        })

        if (!response.ok) {
          throw new Error(`Failed to fetch image: ${response.status}`)
        }

        const blob = await response.blob()
        if (isMounted) {
          const url = URL.createObjectURL(blob)
          setBlobUrl(url)
        }
      } catch (err) {
        console.error('Failed to load image:', err)
        if (isMounted) {
          setError(true)
        }
      } finally {
        if (isMounted) {
          setIsLoading(false)
        }
      }
    }

    fetchImage()

    return () => {
      isMounted = false
      // Clean up blob URL when component unmounts
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl)
      }
    }
  }, [attachmentId, isImage])

  // Clean up blob URL when it changes
  useEffect(() => {
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl)
      }
    }
  }, [blobUrl])

  return { blobUrl, isLoading, error }
}

export default function AttachmentPreview({
  attachment,
  showDownload = true,
  compact = false,
}: AttachmentPreviewProps) {
  const [showLightbox, setShowLightbox] = useState(false)

  const handleDownload = useCallback(async () => {
    try {
      await downloadAttachment(attachment.id, attachment.filename)
    } catch (err) {
      console.error('Failed to download attachment:', err)
    }
  }, [attachment.id, attachment.filename])

  const handleImageClick = useCallback(() => {
    setShowLightbox(true)
  }, [])

  const handleCloseLightbox = useCallback(() => {
    setShowLightbox(false)
  }, [])

  const icon = getFileIcon(attachment.file_extension)
  const isImage = isImageExtension(attachment.file_extension)

  // Use authenticated image fetching
  const {
    blobUrl: imageUrl,
    isLoading: imageLoading,
    error: imageError,
  } = useAuthenticatedImage(attachment.id, isImage)

  // Render image preview for image types
  if (isImage && !imageError) {
    // Show loading state while fetching image
    if (imageLoading) {
      if (compact) {
        return (
          <div className="inline-flex items-center justify-center h-12 w-12 rounded-md border border-border bg-muted">
            <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
          </div>
        )
      }
      return (
        <div className="flex items-center justify-center max-w-[300px] max-h-[200px] min-h-[100px] rounded-lg border border-border bg-muted mb-2">
          <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
        </div>
      )
    }

    // Show image preview once loaded
    if (imageUrl) {
      if (compact) {
        return (
          <>
            <div
              className="inline-block cursor-pointer rounded-md overflow-hidden border border-border hover:border-primary transition-colors"
              onClick={handleImageClick}
              title={attachment.filename}
            >
              <img src={imageUrl} alt={attachment.filename} className="h-12 w-12 object-cover" />
            </div>
            {showLightbox && (
              <ImageLightbox
                src={imageUrl}
                alt={attachment.filename}
                onClose={handleCloseLightbox}
                onDownload={handleDownload}
              />
            )}
          </>
        )
      }

      return (
        <>
          <div className="relative group mb-2 max-w-full">
            <div
              className="cursor-pointer rounded-lg overflow-hidden border border-border hover:border-primary transition-colors"
              onClick={handleImageClick}
            >
              <img
                src={imageUrl}
                alt={attachment.filename}
                className="max-w-full max-h-[200px] object-contain bg-muted"
              />
            </div>
            {/* Overlay with filename and actions */}
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity">
              <div className="flex items-center justify-between gap-2">
                <span
                  className="text-white text-xs truncate flex-1 min-w-0"
                  title={attachment.filename}
                >
                  {attachment.filename}
                </span>
                {showDownload && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={e => {
                      e.stopPropagation()
                      handleDownload()
                    }}
                    className="h-6 w-6 text-white hover:bg-white/20 flex-shrink-0"
                    title="下载"
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          </div>
          {showLightbox && (
            <ImageLightbox
              src={imageUrl}
              alt={attachment.filename}
              onClose={handleCloseLightbox}
              onDownload={handleDownload}
            />
          )}
        </>
      )
    }
  }

  // Fallback to original file icon display for non-image types or image load errors
  if (compact) {
    return (
      <div className="inline-flex items-center gap-1.5 px-2 py-1 bg-muted rounded-md border border-border text-xs">
        <span>{icon}</span>
        <span className="truncate max-w-[120px]" title={attachment.filename}>
          {attachment.filename}
        </span>
        {showDownload && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleDownload}
            className="h-4 w-4 p-0 hover:bg-transparent"
            title="下载"
          >
            <Download className="h-3 w-3 text-text-muted" />
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3 p-3 bg-muted rounded-lg border border-border mb-2 max-w-full">
      <span className="text-2xl flex-shrink-0">{icon}</span>
      <div className="flex-1 min-w-0 overflow-hidden">
        <div className="font-medium text-sm truncate" title={attachment.filename}>
          {attachment.filename}
        </div>
        <div className="text-xs text-text-muted">
          {formatFileSize(attachment.file_size)}
          {showDownload && (
            <button onClick={handleDownload} className="ml-2 text-link hover:underline">
              点击下载
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
