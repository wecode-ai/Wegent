// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  EditIcon,
  RegenerateIcon,
  ReplaceImageIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
} from './ActionIcons'
import { EntityThumbnailStrip } from '@wecode/features/video/entity/EntityThumbnailStrip'
import { EntityDescriptionBubble } from '@wecode/features/video/entity/EntityDescriptionBubble'
import { EntityDescriptionEditor } from '@wecode/features/video/entity/EntityDescriptionEditor'
import { getRatioDimensions } from './ratioDimensions'
import { useTranslation } from '@/hooks/useTranslation'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import type { ThumbnailItem } from '@wecode/features/video/entity/EntityThumbnailStrip'
import { ImageLightbox } from './ImageLightbox'

interface CarouselViewProps {
  // Current item info
  title: string
  currentIndex: number
  totalCount: number
  titleAccessory?: React.ReactNode
  hideTitleBar?: boolean

  // Media display
  mediaUrl?: string | null
  mediaAlt?: string
  mediaType?: 'image' | 'video'
  isLoading?: boolean

  // Dimensions
  ratio?: string
  fixedImageWidth?: number
  fixedImageHeight?: number

  // Action states
  isRegenerating?: boolean
  isRegenerateDisabled?: boolean
  isReplacing?: boolean
  hasFailed?: boolean
  isEditing?: boolean
  editDescription?: string
  editVoiceProfile?: string

  // Entity type
  entityType?: number

  // Editor mode (for entity panel with voice_profile support)
  useEditor?: boolean

  // Thumbnails
  thumbnailItems: ThumbnailItem[]
  thumbWidth?: number
  thumbHeight?: number

  // Description
  description?: string
  showMaxLength?: boolean
  voiceProfile?: string

  // Callbacks
  onPrev: () => void
  onNext: () => void
  onGoTo: (index: number) => void
  onEditStart: () => void
  onEditCancel: () => void
  onEditSave: () => void
  onEditDescriptionChange: (value: string) => void
  onEditVoiceProfileChange: (value: string) => void
  onRegenerate: () => void
  onReplace?: () => void

  // Read-only mode
  readOnly?: boolean

  // Custom renderers
  renderMedia?: () => React.ReactNode
  renderOverlay?: () => React.ReactNode
}

export function CarouselView({
  title,
  currentIndex,
  totalCount,
  titleAccessory,
  hideTitleBar = false,
  mediaUrl,
  mediaAlt,
  mediaType = 'image',
  isLoading,
  ratio,
  fixedImageWidth,
  fixedImageHeight,
  isRegenerating,
  isRegenerateDisabled = false,
  isReplacing,
  hasFailed,
  isEditing,
  editDescription = '',
  editVoiceProfile = '',
  entityType,
  thumbnailItems,
  description = '',
  showMaxLength = true,
  voiceProfile = '',
  onPrev,
  onNext,
  onGoTo,
  onEditStart,
  onEditCancel,
  onEditSave,
  onEditDescriptionChange,
  onEditVoiceProfileChange,
  onRegenerate,
  onReplace,
  useEditor = false,
  readOnly = false,
  renderMedia,
  renderOverlay,
}: CarouselViewProps) {
  const hasPrev = currentIndex > 0
  const hasNext = currentIndex < totalCount - 1
  const { imageWidth: ratioWidth, imageHeight, thumbWidth, thumbHeight } = getRatioDimensions(ratio)
  const { t } = useTranslation('video')
  const isMobile = useIsMobile()

  // Responsive sizing: cap image width on mobile to prevent overflow
  const calculatedWidth = fixedImageWidth ?? ratioWidth
  const calculatedHeight = fixedImageHeight ?? imageHeight
  const displayWidth = isMobile ? Math.min(calculatedWidth, 280) : calculatedWidth
  const displayHeight = isMobile
    ? Math.round((280 / calculatedWidth) * calculatedHeight)
    : calculatedHeight
  const useResponsiveMobileMediaFrame = isMobile
  const mobileImageRatioPaddingTop = `${(displayHeight / displayWidth) * 100}%`

  // Lightbox state
  const [isLightboxOpen, setIsLightboxOpen] = useState(false)

  // Desktop: fixed width layout matching design
  // Image: 503px, Input box: 640px - use 640px as container width for both
  // Mobile: responsive layout with percentage-based sizing
  const DESIGN_IMAGE_WIDTH = 503
  const DESIGN_CONTAINER_WIDTH = 640
  const DESIGN_ARROW_PADDING = 14
  const mediaWrapperWidth = isMobile ? '100%' : DESIGN_CONTAINER_WIDTH
  const mediaPadding = isMobile ? '0 36px' : `0 ${DESIGN_ARROW_PADDING}px`
  const titleRowWidth = isMobile ? '100%' : DESIGN_CONTAINER_WIDTH
  const titleAccessoryRight = isMobile ? '0px' : '35px'
  const mediaContainerWidth = isMobile ? '100%' : DESIGN_IMAGE_WIDTH
  const mediaContainerHeight = isMobile ? 'auto' : displayHeight
  const mediaContainerAspectRatio =
    isMobile && !useResponsiveMobileMediaFrame ? displayWidth / displayHeight : undefined

  return (
    <div
      className="relative flex flex-col items-center w-full max-w-full overflow-x-hidden"
      style={{
        paddingLeft: isMobile ? '14px' : '40px',
        paddingRight: isMobile ? '14px' : '40px',
        marginTop: hideTitleBar ? '0px' : '16px',
      }}
    >
      {/* Top section: Title + Media + Action buttons */}
      <div
        className="relative flex flex-col items-center"
        style={{ width: isMobile ? '100%' : DESIGN_IMAGE_WIDTH + DESIGN_ARROW_PADDING * 2 }}
      >
        {!hideTitleBar && (
          <div
            className="relative mb-3 flex min-h-[24px] items-center justify-center"
            style={{ width: titleRowWidth }}
          >
            <h3
              className="text-[15px] text-text-primary leading-[1.53] text-center"
              style={{ fontFamily: "'PingFang TC', sans-serif" }}
            >
              {title}
            </h3>
            {titleAccessory ? (
              <div
                className="absolute top-1/2 flex -translate-y-1/2 items-center"
                style={{ right: titleAccessoryRight }}
              >
                {titleAccessory}
              </div>
            ) : null}
          </div>
        )}

        {/* Media wrapper with fixed width and padding for arrows */}
        <div
          className="relative flex justify-center"
          style={{ width: mediaWrapperWidth, padding: mediaPadding }}
        >
          {/* Left arrow */}
          {hasPrev && (
            <button
              onClick={onPrev}
              className="absolute left-0 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white flex items-center justify-center z-10 shadow-[0_2px_8.75px_0_rgba(160,160,160,0.25)] hover:shadow-[0_2px_8.75px_0_rgba(160,160,160,0.35)] active:shadow-[0_1px_4px_0_rgba(160,160,160,0.25)] focus-visible:outline-none transition-shadow"
            >
              <ArrowLeftIcon className="w-6 h-6 text-text-primary" />
            </button>
          )}

          {/* Media container */}
          <div
            data-testid="carousel-media-frame"
            className="rounded-lg overflow-hidden bg-transparent flex items-center justify-center relative"
            style={{
              width: mediaContainerWidth,
              height: mediaContainerHeight,
              aspectRatio: mediaContainerAspectRatio,
            }}
          >
            {useResponsiveMobileMediaFrame && (
              <div
                data-testid="carousel-media-ratio-box"
                className="w-full"
                style={{ paddingTop: mobileImageRatioPaddingTop }}
              />
            )}
            {isLoading ? (
              <div
                className={
                  useResponsiveMobileMediaFrame
                    ? 'absolute inset-0 flex items-center justify-center'
                    : 'flex items-center justify-center'
                }
                style={{
                  height: isMobile && !useResponsiveMobileMediaFrame ? '100%' : displayHeight,
                }}
              >
                <Loader2 className="w-8 h-8 animate-spin text-text-muted" />
              </div>
            ) : renderMedia ? (
              useResponsiveMobileMediaFrame ? (
                <div className="absolute inset-0">{renderMedia()}</div>
              ) : (
                renderMedia()
              )
            ) : mediaUrl ? (
              mediaType === 'image' ? (
                <div className="absolute inset-0">
                  <img
                    src={mediaUrl}
                    alt={mediaAlt}
                    className="block w-full h-full object-cover rounded-lg cursor-pointer"
                    onClick={() => setIsLightboxOpen(true)}
                  />
                </div>
              ) : null
            ) : isRegenerating ? (
              <div
                className={
                  useResponsiveMobileMediaFrame
                    ? 'absolute inset-0 flex items-center justify-center bg-gray-50 rounded-lg'
                    : 'flex items-center justify-center bg-gray-50 rounded-lg w-full h-full'
                }
              />
            ) : (
              <div
                className={
                  useResponsiveMobileMediaFrame
                    ? 'absolute inset-0 flex items-center justify-center text-sm text-text-muted'
                    : 'flex items-center justify-center text-sm text-text-muted w-full h-full'
                }
              >
                {t('no_content')}
              </div>
            )}

            {/* Custom overlay */}
            {renderOverlay?.()}

            {/* Regenerating overlay - only show when not using custom renderMedia */}
            {isRegenerating && !renderMedia && (
              <div className="absolute inset-0 bg-black/40 flex items-center justify-center rounded-lg">
                <div className="flex flex-col items-center gap-2">
                  <Loader2 className="w-8 h-8 animate-spin text-white" />
                  <span className="text-sm text-white">{t('generating')}</span>
                </div>
              </div>
            )}

            {/* Replacing overlay */}
            {isReplacing && (
              <div className="absolute inset-0 bg-black/40 flex items-center justify-center rounded-lg">
                <div className="flex flex-col items-center gap-2">
                  <Loader2 className="w-8 h-8 animate-spin text-white" />
                  <span className="text-sm text-white">{t('uploading')}</span>
                </div>
              </div>
            )}

            {/* Failed overlay */}
            {hasFailed && (
              <div className="absolute inset-0 bg-gray-50/90 flex items-center justify-center rounded-lg">
                <div className="flex flex-row items-center gap-2">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="7.5" fill="#6B7280" />
                    <rect x="7.5" y="4" width="1" height="5" fill="white" />
                    <rect x="7.5" y="10.5" width="1" height="1" fill="white" />
                  </svg>
                  <span
                    className="text-[15px] text-text-primary"
                    style={{ fontFamily: "'PingFang SC', sans-serif", lineHeight: '100%' }}
                  >
                    {mediaType === 'video'
                      ? t('video_generation_failed')
                      : t('image_generation_failed')}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Right arrow */}
          {hasNext && (
            <button
              onClick={onNext}
              className="absolute right-0 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white flex items-center justify-center z-10 shadow-[0_2px_8.75px_0_rgba(160,160,160,0.25)] hover:shadow-[0_2px_8.75px_0_rgba(160,160,160,0.35)] active:shadow-[0_1px_4px_0_rgba(160,160,160,0.25)] focus-visible:outline-none transition-shadow"
            >
              <ArrowRightIcon className="w-6 h-6 text-text-primary" />
            </button>
          )}
        </div>

        {/* Action buttons row (hidden in readOnly mode) */}
        {!readOnly && (
          <div className="flex justify-center gap-2 mt-2">
            <button
              onClick={onEditStart}
              className="flex items-center gap-[2px] px-3 py-1.5 rounded-[20px] active:bg-[#f0f1f2] transition-colors [@media(hover:hover)]:hover:bg-[#f0f1f2]"
            >
              <EditIcon className="w-4 h-4 text-text-primary" />
              <span
                className="text-sm text-text-primary"
                style={{ fontFamily: "'PingFang SC', sans-serif" }}
              >
                {t('edit')}
              </span>
            </button>
            <button
              onClick={onRegenerate}
              disabled={isRegenerating || isRegenerateDisabled}
              className="flex items-center gap-[3px] px-3 py-1.5 rounded-[20px] active:bg-[#f0f1f2] transition-colors disabled:opacity-50 [@media(hover:hover)]:hover:bg-[#f0f1f2]"
            >
              <RegenerateIcon
                className={`w-4 h-4 text-text-primary ${isRegenerating ? 'animate-spin' : ''}`}
              />
              <span
                className="text-sm text-text-primary"
                style={{ fontFamily: "'PingFang SC', sans-serif" }}
              >
                {t('regenerate')}
              </span>
            </button>
            {onReplace && (
              <button
                onClick={onReplace}
                disabled={isReplacing}
                className="flex items-center gap-[3px] px-3 py-1.5 rounded-[20px] active:bg-[#f0f1f2] transition-colors disabled:opacity-50 [@media(hover:hover)]:hover:bg-[#f0f1f2]"
              >
                <ReplaceImageIcon className="w-4 h-4 text-text-primary" />
                <span
                  className="text-sm text-text-primary"
                  style={{ fontFamily: "'PingFang SC', sans-serif" }}
                >
                  {mediaType === 'video' ? t('replace_video') : t('replace_image')}
                </span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Bottom section: Thumbnail strip + Description bubble */}
      <div
        className={`mt-[22px] flex flex-col ${isMobile ? '' : 'items-center'}`}
        style={{ width: isMobile ? '100%' : 640 + 2 }}
      >
        {/* Thumbnail strip */}
        <div className="mb-4 relative w-full">
          <EntityThumbnailStrip
            entities={thumbnailItems}
            activeIndex={currentIndex}
            onSelectIndex={onGoTo}
            thumbWidth={thumbWidth}
            thumbHeight={thumbHeight}
          />
        </div>
        {/* Description bubble */}
        <div
          className={`${isMobile ? 'w-full' : ''}`}
          style={!isMobile ? { width: `${640 + 2}px` } : undefined}
        >
          {useEditor ? (
            <EntityDescriptionEditor
              description={isEditing ? editDescription : description}
              voiceProfile={isEditing ? editVoiceProfile : voiceProfile}
              isEditing={isEditing ?? false}
              entityType={entityType}
              activeIndex={currentIndex}
              thumbWidth={thumbWidth}
              onDescriptionChange={onEditDescriptionChange}
              onVoiceProfileChange={onEditVoiceProfileChange}
              onSave={onEditSave}
              onCancel={onEditCancel}
            />
          ) : (
            <EntityDescriptionBubble
              description={isEditing ? editDescription : description}
              isEditing={isEditing ?? false}
              activeIndex={currentIndex}
              thumbWidth={thumbWidth}
              maxLength={1500}
              showMaxLength={showMaxLength}
              onChange={onEditDescriptionChange}
              onSave={onEditSave}
              onCancel={onEditCancel}
            />
          )}
        </div>
      </div>

      {/* Image Lightbox - only for images */}
      {mediaType === 'image' && mediaUrl && (
        <ImageLightbox
          src={mediaUrl}
          alt={mediaAlt}
          isOpen={isLightboxOpen}
          onClose={() => setIsLightboxOpen(false)}
        />
      )}
    </div>
  )
}
