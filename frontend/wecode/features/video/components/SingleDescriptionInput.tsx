// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'

interface SingleDescriptionInputProps {
  value: string
  isEditing: boolean
  title?: string
  maxLength?: number
  width?: number
  showTitle?: boolean
  showButtons?: boolean
  showMaxLength?: boolean
  useGradientBorder?: boolean
  placeholder?: string
  onChange?: (value: string) => void
  onSave?: () => void
  onCancel?: () => void
}

export function SingleDescriptionInput({
  value,
  isEditing,
  title,
  maxLength = 200,
  width = 640,
  showTitle = false,
  showButtons = false,
  showMaxLength = true,
  placeholder,
  onChange,
  onSave,
  onCancel,
}: SingleDescriptionInputProps) {
  const { t } = useTranslation('video')
  const isMobile = useIsMobile()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const isIOSDevice = useCallback(() => {
    if (typeof navigator === 'undefined') return false

    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    )
  }, [])

  // Responsive width: use 100% on mobile, fixed width on desktop
  const containerWidth = isMobile ? '100%' : `${width + 2}px`
  const contentWidth = isMobile ? `${width}px` : `${width}px`

  const getScrollContainer = useCallback((element: HTMLElement): HTMLElement | Window => {
    let parent = element.parentElement

    while (parent) {
      const style = window.getComputedStyle(parent)
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        return parent
      }
      parent = parent.parentElement
    }

    return window
  }, [])

  const getScrollTop = useCallback((scrollContainer: HTMLElement | Window): number => {
    return scrollContainer instanceof Window ? scrollContainer.scrollY : scrollContainer.scrollTop
  }, [])

  const restoreScrollTop = useCallback(
    (scrollContainer: HTMLElement | Window, scrollTop: number) => {
      if (scrollContainer instanceof Window) {
        scrollContainer.scrollTo({ top: scrollTop, behavior: 'auto' })
        return
      }

      scrollContainer.scrollTop = scrollTop
    },
    []
  )

  // Auto-resize textarea based on content
  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    // Use scrollHeight directly without setting 'auto' first to prevent page jump
    const newHeight = textarea.scrollHeight
    textarea.style.height = `${newHeight}px`
  }, [])

  const handleFocus = useCallback(() => {
    if (!isMobile || !isIOSDevice()) return

    const textarea = textareaRef.current
    if (!textarea) return

    const scrollContainer = getScrollContainer(textarea)
    const containerScrollTop = getScrollTop(scrollContainer)
    const windowScrollTop = window.scrollY
    const initialViewportOffsetTop = window.visualViewport?.offsetTop ?? 0

    window.setTimeout(() => {
      const currentTextarea = textareaRef.current
      if (!currentTextarea) return

      restoreScrollTop(scrollContainer, containerScrollTop)

      if (window.scrollY !== windowScrollTop) {
        window.scrollTo({ top: windowScrollTop, behavior: 'auto' })
      }

      const visualViewport = window.visualViewport
      if (!visualViewport || visualViewport.offsetTop === initialViewportOffsetTop) {
        return
      }

      const rect = currentTextarea.getBoundingClientRect()
      const visibleTop = visualViewport.offsetTop
      const visibleBottom = visualViewport.offsetTop + visualViewport.height
      if (rect.top < visibleTop || rect.bottom > visibleBottom) {
        currentTextarea.scrollIntoView({
          block: 'nearest',
          inline: 'nearest',
          behavior: 'smooth',
        })
      }
    }, 100)
  }, [getScrollContainer, getScrollTop, isIOSDevice, isMobile, restoreScrollTop])

  // Resize when entering edit mode without stealing focus on mobile browsers.
  useEffect(() => {
    if (!isEditing) return

    const timerId = window.setTimeout(() => {
      const textarea = textareaRef.current
      if (!textarea) return

      if (isMobile) {
        if (document.activeElement === textarea) {
          textarea.blur()
        }
      } else {
        textarea.focus({ preventScroll: true })
        textarea.setSelectionRange(textarea.value.length, textarea.value.length)
      }

      adjustHeight()
    }, 0)

    return () => window.clearTimeout(timerId)
  }, [adjustHeight, isEditing, isMobile])

  // Resize when value or isEditing changes
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const scrollContainer = getScrollContainer(textarea)
    const scrollTop = getScrollTop(scrollContainer)
    // Reset to auto first to get correct scrollHeight
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
    restoreScrollTop(scrollContainer, scrollTop)
  }, [getScrollContainer, getScrollTop, isEditing, restoreScrollTop, value])

  // Initial mount: adjust height after layout is complete
  useEffect(() => {
    // Use multiple requestAnimationFrame and setTimeout to ensure DOM is fully rendered
    // This handles font loading delays and container size changes
    const adjustWithDelay = () => {
      adjustHeight()
      requestAnimationFrame(() => adjustHeight())
      setTimeout(() => adjustHeight(), 100)
      setTimeout(() => adjustHeight(), 300)
    }
    adjustWithDelay()
  }, [adjustHeight])

  // Adjust height when value changes from external source (e.g., opening panel with existing content)
  useEffect(() => {
    const adjustWithDelay = () => {
      requestAnimationFrame(() => adjustHeight())
      setTimeout(() => adjustHeight(), 50)
    }
    adjustWithDelay()
  }, [adjustHeight, value])

  // Adjust height when entering edit mode (container size may change)
  useEffect(() => {
    if (isEditing) {
      const adjustWithDelay = () => {
        requestAnimationFrame(() => adjustHeight())
        setTimeout(() => adjustHeight(), 50)
        setTimeout(() => adjustHeight(), 150)
      }
      adjustWithDelay()
    }
  }, [adjustHeight, isEditing])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      onSave?.()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel?.()
    }
  }

  // Common textarea styles
  const textareaStyles: React.CSSProperties = {
    fontFamily: "'PingFang SC', sans-serif",
    fontWeight: 400,
    fontSize: '14px',
    color: '#333333',
    border: 'none',
    padding: '0',
    margin: '0',
    lineHeight: '22px',
    minHeight: '22px',
    boxSizing: 'border-box',
  }

  // Title component
  const TitleComponent =
    showTitle && title ? (
      <div
        className="ml-1 transition-opacity duration-150"
        style={{
          fontFamily: "'PingFang SC', sans-serif",
          fontWeight: 400,
          fontSize: '14px',
          lineHeight: '20px',
          color: '#939393',
          marginBottom: '8px',
        }}
      >
        {title}
      </div>
    ) : null

  // Edit mode
  if (isEditing) {
    return (
      <div className="relative flex flex-col">
        {TitleComponent}
        {/* Edit mode with gradient border - matches Pencil design */}
        <div
          className={`relative max-w-full ${isMobile ? 'flex' : ''}`}
          style={{ width: containerWidth }}
        >
          {/* Gradient border layer */}
          <div
            className="absolute inset-0 rounded-lg pointer-events-none"
            style={{
              background: 'rgba(255, 130, 0, 0.4)',
              zIndex: 0,
            }}
          />
          {/* Content container */}
          <div
            className="relative bg-white rounded-lg flex flex-col max-w-full"
            style={{
              minHeight: '64px',
              margin: '1px',
              padding: '8px 12px 12px 12px',
              boxSizing: 'border-box',
              zIndex: 1,
              ...(!isMobile && { width: `${width}px` }),
              ...(isMobile && { flex: '1 1 auto' }),
            }}
          >
            <textarea
              ref={textareaRef}
              value={value}
              onFocus={handleFocus}
              onChange={e => {
                if (e.target.value.length <= maxLength) {
                  onChange?.(e.target.value)
                  // Auto-resize on next frame
                  requestAnimationFrame(adjustHeight)
                }
              }}
              onKeyDown={handleKeyDown}
              rows={1}
              className="w-full resize-none outline-none text-sm bg-transparent overflow-hidden block"
              style={{
                ...textareaStyles,
                flex: '0 0 auto',
              }}
              placeholder={placeholder}
            />
            {showMaxLength && (
              <div className="flex items-center justify-start" style={{ marginTop: '10px' }}>
                <span
                  className="text-xs text-text-muted"
                  style={{
                    fontFamily: "'Microsoft YaHei', sans-serif",
                    lineHeight: '12px',
                    height: '12px',
                  }}
                >
                  {value.length}/{maxLength}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Action buttons */}
        {showButtons && (
          <div
            className="flex items-center justify-end w-full max-w-full"
            style={{ gap: '12px', marginTop: '16px', ...(!isMobile && { width: contentWidth }) }}
          >
            <button
              type="button"
              onClick={onCancel}
              className="text-xs text-text-primary transition-colors hover:bg-black/10"
              style={{
                backgroundColor: 'rgba(51, 51, 51, 0.06)',
                padding: '3px 14px',
                borderRadius: '6px',
                height: '24px',
                fontFamily: "'PingFang SC', sans-serif",
                fontWeight: 400,
                lineHeight: '18px',
              }}
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              onClick={onSave}
              className="text-xs text-white transition-colors hover:opacity-90"
              style={{
                backgroundColor: '#FF8200',
                padding: '3px 14px',
                borderRadius: '6px',
                height: '24px',
                fontFamily: "'PingFang SC', sans-serif",
                fontWeight: 400,
                lineHeight: '18px',
              }}
            >
              {t('confirm')}
            </button>
          </div>
        )}
      </div>
    )
  }

  // View mode
  return (
    <div className="relative flex flex-col">
      {TitleComponent}
      {/* View mode with gray border - same structure as edit mode for smooth transition */}
      <div
        className={`relative max-w-full ${isMobile ? 'flex' : ''}`}
        style={{ width: containerWidth }}
      >
        {/* Solid gray border layer */}
        <div
          className="absolute inset-0 rounded-lg pointer-events-none"
          style={{
            backgroundColor: '#EEEEEE',
            zIndex: 0,
          }}
        />
        {/* Content container */}
        <div
          className="relative bg-white rounded-lg flex flex-col max-w-full"
          style={{
            minHeight: '64px',
            margin: '1px',
            padding: '8px 12px 12px 12px',
            boxSizing: 'border-box',
            zIndex: 1,
            ...(!isMobile && { width: `${width}px` }),
            ...(isMobile && { flex: '1 1 auto' }),
          }}
        >
          <textarea
            readOnly
            ref={textareaRef}
            value={value}
            rows={1}
            className="w-full resize-none outline-none text-sm bg-transparent overflow-hidden block"
            style={{
              ...textareaStyles,
              cursor: 'default',
              flex: '0 0 auto',
            }}
          />
          {showMaxLength && (
            <div className="flex items-center justify-start" style={{ marginTop: '10px' }}>
              <span
                className="text-xs text-text-muted"
                style={{
                  fontFamily: "'Microsoft YaHei', sans-serif",
                  lineHeight: '12px',
                  height: '12px',
                }}
              >
                {value.length}/{maxLength}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
