// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AudioLines,
  Download,
  Eye,
  FileText,
  Loader2,
  Pause,
  Play,
  RotateCw,
  Video,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  formatFileSize,
  getFileIcon,
  downloadAttachment,
  createAttachmentDownloadUrl,
  getAttachmentDownloadUrl,
  isImageExtension,
  isAudioExtension,
  isHtmlExtension,
  isVideoExtension,
} from '@/apis/attachments'
import type { Attachment } from '@/types/api'
import { useAttachmentImage } from '@/hooks/useAttachmentImage'
import { FilePreviewDialog } from '@/components/common/FilePreview'
import { useTranslation } from '@/hooks/useTranslation'

interface AttachmentPreviewProps {
  /** Attachment data */
  attachment: Attachment
  /** Whether to show download button */
  showDownload?: boolean
  /** Compact mode (smaller size) */
  compact?: boolean
  /** Share token for public access (no login required) */
  shareToken?: string
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
  const { t } = useTranslation('common')
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
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
    >
      {/* Toolbar */}
      <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleZoomOut}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title={`${t('actions.zoom_out')} (-)`}
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
          title={`${t('actions.zoom_in')} (+)`}
        >
          <ZoomIn className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleRotate}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title={`${t('actions.rotate')} (R)`}
        >
          <RotateCw className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onDownload}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title={t('actions.download')}
        >
          <Download className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title={`${t('actions.close')} (Esc)`}
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      {/* Image container */}
      <div className="max-w-[90vw] max-h-[90vh] overflow-auto">
        {/* eslint-disable-next-line @next/next/no-img-element */}
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
    </div>
  )
}

export default function AttachmentPreview({
  attachment,
  showDownload = true,
  compact = false,
  shareToken,
}: AttachmentPreviewProps) {
  const { t } = useTranslation('common')
  const [showLightbox, setShowLightbox] = useState(false)
  const [showPreviewDialog, setShowPreviewDialog] = useState(false)
  const [showVideoDialog, setShowVideoDialog] = useState(false)
  const [isAudioPlaying, setIsAudioPlaying] = useState(false)
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [mediaLoading, setMediaLoading] = useState(false)
  const [mediaError, setMediaError] = useState(false)
  const videoPreviewRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  const handleDownload = useCallback(async () => {
    try {
      await downloadAttachment(attachment.id, attachment.filename, shareToken)
    } catch (err) {
      console.error('Failed to download attachment:', err)
    }
  }, [attachment.id, attachment.filename, shareToken])

  const handleImageClick = useCallback(() => {
    setShowLightbox(true)
  }, [])

  const handleCloseLightbox = useCallback(() => {
    setShowLightbox(false)
  }, [])

  const handlePreviewClick = useCallback(() => {
    setShowPreviewDialog(true)
  }, [])

  const handleClosePreviewDialog = useCallback(() => {
    setShowPreviewDialog(false)
  }, [])

  const icon = getFileIcon(attachment.file_extension)
  const isImage = isImageExtension(attachment.file_extension)
  const isHtml = isHtmlExtension(attachment.file_extension)
  const isVideo = isVideoExtension(attachment.file_extension)
  const isAudio = isAudioExtension(attachment.file_extension)

  // Images use a Blob URL; video and audio use a tokenized URL so browsers can
  // request byte ranges without downloading the complete file first.
  const {
    blobUrl: imageUrl,
    isLoading: imageLoading,
    error: imageError,
  } = useAttachmentImage(attachment.id, isImage, shareToken)

  useEffect(() => {
    if (!isVideo && !isAudio) return

    let active = true
    setMediaLoading(true)
    setMediaError(false)

    const resolveUrl = async () => {
      try {
        const url = shareToken
          ? getAttachmentDownloadUrl(attachment.id, shareToken)
          : await createAttachmentDownloadUrl(attachment.id)
        if (active) setMediaUrl(url)
      } catch (error) {
        console.error('Failed to resolve attachment media URL:', error)
        if (active) setMediaError(true)
      } finally {
        if (active) setMediaLoading(false)
      }
    }

    void resolveUrl()
    return () => {
      active = false
    }
  }, [attachment.id, isAudio, isVideo, shareToken])

  const lightbox =
    showLightbox && typeof document !== 'undefined'
      ? createPortal(
          <ImageLightbox
            src={imageUrl ?? ''}
            alt={attachment.filename}
            onClose={handleCloseLightbox}
            onDownload={handleDownload}
          />,
          document.body
        )
      : null

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
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageUrl} alt={attachment.filename} className="h-12 w-12 object-cover" />
            </div>
            {lightbox}
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
              {/* eslint-disable-next-line @next/next/no-img-element */}
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
                    title={t('actions.download')}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          </div>
          {lightbox}
        </>
      )
    }
  }

  // Protected media is loaded through an authenticated attachment URL.
  if (isVideo) {
    if (mediaLoading) {
      return (
        <div className="flex h-16 w-16 items-center justify-center rounded-md border border-border bg-black">
          <Loader2 className="h-4 w-4 animate-spin text-white/70" />
        </div>
      )
    }

    return (
      <>
        <button
          type="button"
          data-testid={`sent-video-attachment-${attachment.id}`}
          onClick={() => mediaUrl && setShowVideoDialog(true)}
          onMouseEnter={() => {
            void videoPreviewRef.current?.play().catch(() => undefined)
          }}
          onMouseLeave={() => {
            videoPreviewRef.current?.pause()
          }}
          className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-md border border-border bg-black text-white transition-transform hover:z-10 hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          title={attachment.filename}
        >
          {mediaUrl && !mediaError ? (
            <video
              ref={videoPreviewRef}
              src={mediaUrl}
              muted
              playsInline
              preload="metadata"
              onLoadedData={event => {
                if (event.currentTarget.currentTime === 0) {
                  event.currentTarget.currentTime = 0.01
                }
              }}
              className="h-full w-full object-cover"
            />
          ) : (
            <Video className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2" />
          )}
          <span className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 transition-opacity group-hover:opacity-100">
            <Play className="h-5 w-5 fill-white" />
          </span>
          <span className="absolute bottom-0 left-0 right-0 truncate bg-black/60 px-1 py-0.5 text-[10px]">
            {attachment.filename}
          </span>
        </button>

        <Dialog open={showVideoDialog} onOpenChange={setShowVideoDialog}>
          <DialogContent className="w-[calc(100vw-32px)] max-w-4xl overflow-hidden border-0 bg-black p-0">
            <DialogTitle className="sr-only">{attachment.filename}</DialogTitle>
            <DialogDescription className="sr-only">{attachment.filename}</DialogDescription>
            {mediaUrl && (
              <video
                data-testid={`sent-video-dialog-${attachment.id}`}
                src={mediaUrl}
                controls
                autoPlay
                playsInline
                className="max-h-[80vh] w-full bg-black object-contain"
              />
            )}
          </DialogContent>
        </Dialog>
      </>
    )
  }

  if (isAudio) {
    const toggleAudio = () => {
      const audio = audioRef.current
      if (!audio) return
      if (audio.paused) {
        void audio
          .play()
          .then(() => setIsAudioPlaying(true))
          .catch(() => setIsAudioPlaying(false))
      } else {
        audio.pause()
        setIsAudioPlaying(false)
      }
    }

    return (
      <div
        data-testid={`sent-audio-attachment-${attachment.id}`}
        className="flex h-12 max-w-52 items-center gap-2 rounded-md border border-border bg-surface px-2"
      >
        <audio
          ref={audioRef}
          src={mediaUrl ?? undefined}
          preload="metadata"
          onEnded={() => setIsAudioPlaying(false)}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={toggleAudio}
          disabled={!mediaUrl || mediaLoading || mediaError}
          className="h-8 w-8 shrink-0 text-primary"
          title={isAudioPlaying ? t('actions.pause') : t('actions.play')}
        >
          {mediaLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : isAudioPlaying ? (
            <Pause className="h-4 w-4 fill-current" />
          ) : (
            <Play className="h-4 w-4 fill-current" />
          )}
        </Button>
        <div className="min-w-0 flex-1 text-left">
          <div className="truncate text-xs font-medium" title={attachment.filename}>
            {attachment.filename}
          </div>
          <div className="text-[11px] text-text-muted">{formatFileSize(attachment.file_size)}</div>
        </div>
        <AudioLines className="h-4 w-4 shrink-0 text-text-muted" />
      </div>
    )
  }

  // HTML files - show preview button
  if (isHtml) {
    if (compact) {
      return (
        <>
          <div className="inline-flex items-center gap-1.5 px-2 py-1 bg-muted rounded-md border border-border text-xs">
            <span>{icon}</span>
            <span className="truncate max-w-[120px]" title={attachment.filename}>
              {attachment.filename}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={handlePreviewClick}
              className="h-4 w-4 p-0 hover:bg-transparent"
              title={t('actions.preview')}
            >
              <Eye className="h-3 w-3 text-text-muted" />
            </Button>
            {showDownload && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={handleDownload}
                className="h-4 w-4 p-0 hover:bg-transparent"
                title={t('actions.download')}
              >
                <Download className="h-3 w-3 text-text-muted" />
              </Button>
            )}
          </div>
          <FilePreviewDialog
            open={showPreviewDialog}
            onClose={handleClosePreviewDialog}
            attachmentId={attachment.id}
            filename={attachment.filename}
            mimeType={attachment.mime_type}
            fileSize={attachment.file_size}
            shareToken={shareToken}
            canShare={!shareToken}
          />
        </>
      )
    }

    return (
      <>
        <div className="flex items-center gap-3 p-3 bg-muted rounded-lg border border-border mb-2 max-w-full">
          <span className="text-2xl flex-shrink-0">{icon}</span>
          <div className="flex-1 min-w-0 overflow-hidden">
            <div className="font-medium text-sm truncate" title={attachment.filename}>
              {attachment.filename}
            </div>
            <div className="text-xs text-text-muted">
              {formatFileSize(attachment.file_size)}
              <button
                type="button"
                onClick={handlePreviewClick}
                className="ml-2 text-link hover:underline"
              >
                {t('attachment.click_to_preview')}
              </button>
              {showDownload && (
                <button
                  type="button"
                  onClick={handleDownload}
                  className="ml-2 text-link hover:underline"
                >
                  {t('actions.download')}
                </button>
              )}
            </div>
          </div>
        </div>
        <FilePreviewDialog
          open={showPreviewDialog}
          onClose={handleClosePreviewDialog}
          attachmentId={attachment.id}
          filename={attachment.filename}
          mimeType={attachment.mime_type}
          fileSize={attachment.file_size}
          shareToken={shareToken}
          canShare={!shareToken}
        />
      </>
    )
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
            title={t('actions.download')}
          >
            <Download className="h-3 w-3 text-text-muted" />
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-[72px] w-60 items-center gap-3 rounded-lg border border-border bg-surface px-3 shadow-sm">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-text-secondary">
        <FileText className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={attachment.filename}>
          {attachment.filename}
        </div>
        <div className="text-xs text-text-muted">{formatFileSize(attachment.file_size)}</div>
      </div>
      {showDownload && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={handleDownload}
          className="h-8 w-8 shrink-0 text-text-muted hover:text-text-primary"
          title={t('actions.download')}
        >
          <Download className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
}
