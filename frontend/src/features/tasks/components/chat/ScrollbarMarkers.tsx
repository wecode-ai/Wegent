// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useCallback, useRef } from 'react'
import { ChevronDown } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'

/** Maximum number of characters to show in the tooltip preview */
const TOOLTIP_PREVIEW_LENGTH = 30

interface MarkerPosition {
  /** Unique identifier for the marker */
  id: string
  /** Position as percentage from top (0-100) */
  percentage: number
  /** Preview text from the user message (first N characters) */
  previewText: string
}

interface ScrollbarMarkersProps {
  /** Reference to the scroll container element */
  scrollContainerRef: React.RefObject<HTMLElement | null>
  /** CSS selector to find user message elements within the scroll container */
  userMessageSelector?: string
  /** Color of the marker dots */
  markerColor?: string
  /** Color of the marker dots on hover */
  markerHoverColor?: string
  /** Size of the marker dots in pixels */
  markerSize?: number
  /** Whether markers are visible */
  visible?: boolean
  /** Maximum characters to show in tooltip preview */
  tooltipPreviewLength?: number
}

/**
 * ScrollbarMarkers Component
 *
 * Displays small dot markers on the right side of a scroll container,
 * indicating the positions of user messages. Similar to Google Gemini's
 * scrollbar annotation feature.
 *
 * The markers are positioned absolutely relative to the scroll container
 * and appear alongside the native scrollbar.
 */
/** Offset in pixels to scroll above the target message so it's fully visible */
const SCROLL_OFFSET_PX = 80

export function ScrollbarMarkers({
  scrollContainerRef,
  userMessageSelector = '[data-message-type="user"]',
  markerColor = 'rgb(var(--color-primary))',
  markerHoverColor = 'rgb(var(--color-primary) / 1)',
  markerSize = 12,
  visible = true,
  tooltipPreviewLength = TOOLTIP_PREVIEW_LENGTH,
}: ScrollbarMarkersProps) {
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null)
  const [markers, setMarkers] = useState<MarkerPosition[]>([])
  const [containerHeight, setContainerHeight] = useState(0)
  const [scrollHeight, setScrollHeight] = useState(0)
  const rafRef = useRef<number | null>(null)

  // Calculate marker positions based on user message elements
  const calculateMarkers = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return

    const scrollableHeight = container.scrollHeight
    const visibleHeight = container.clientHeight

    // Only show markers if content is scrollable
    if (scrollableHeight <= visibleHeight) {
      setMarkers([])
      return
    }

    setContainerHeight(visibleHeight)
    setScrollHeight(scrollableHeight)

    // Find all user message elements
    const userMessages = container.querySelectorAll(userMessageSelector)
    const newMarkers: MarkerPosition[] = []

    userMessages.forEach((element, index) => {
      const htmlElement = element as HTMLElement
      // Get the element's position relative to the scroll container
      const elementTop = htmlElement.offsetTop
      // Calculate percentage position (0-100)
      const percentage = (elementTop / scrollableHeight) * 100

      // Extract text content from the message element
      // Get the text content and clean it up (remove extra whitespace)
      const fullText = htmlElement.textContent?.trim() || ''
      // Truncate to preview length and add ellipsis if needed
      const previewText =
        fullText.length > tooltipPreviewLength
          ? fullText.slice(0, tooltipPreviewLength) + '...'
          : fullText

      newMarkers.push({
        id: `marker-${index}`,
        percentage,
        previewText: previewText || `Message ${index + 1}`,
      })
    })

    setMarkers(newMarkers)
  }, [scrollContainerRef, userMessageSelector, tooltipPreviewLength])

  // Debounced calculation using requestAnimationFrame
  const scheduleCalculation = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
    }
    rafRef.current = requestAnimationFrame(() => {
      calculateMarkers()
    })
  }, [calculateMarkers])

  // Set up observers and event listeners
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    // Initial calculation
    calculateMarkers()

    // Observe DOM changes (new messages added)
    const mutationObserver = new MutationObserver(() => {
      scheduleCalculation()
    })

    mutationObserver.observe(container, {
      childList: true,
      subtree: true,
    })

    // Observe resize changes
    const resizeObserver = new ResizeObserver(() => {
      scheduleCalculation()
    })

    resizeObserver.observe(container)

    // Listen for scroll events to update if needed
    const handleScroll = () => {
      // Markers don't move with scroll, but we might need to recalculate
      // if the scroll height changes dynamically
    }

    container.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      mutationObserver.disconnect()
      resizeObserver.disconnect()
      container.removeEventListener('scroll', handleScroll)
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [scrollContainerRef, calculateMarkers, scheduleCalculation])

  // Handle click on marker to scroll to that position
  // Scrolls slightly above the target so the message bubble is fully visible
  const handleMarkerClick = useCallback(
    (percentage: number) => {
      const container = scrollContainerRef.current
      if (!container) return

      // Calculate target position with offset to show message fully
      const targetScrollTop = Math.max(
        0,
        (percentage / 100) * container.scrollHeight - SCROLL_OFFSET_PX
      )
      container.scrollTo({
        top: targetScrollTop,
        behavior: 'smooth',
      })
    },
    [scrollContainerRef]
  )

  // Handle scroll to bottom
  const handleScrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return

    container.scrollTo({
      top: container.scrollHeight,
      behavior: 'smooth',
    })
  }, [scrollContainerRef])

  const { t } = useTranslation('chat')

  // Don't render if not visible or no markers
  if (!visible || markers.length === 0 || scrollHeight <= containerHeight) {
    return null
  }

  return (
    <TooltipProvider delayDuration={0}>
      <div
        className="absolute right-0 top-0 bottom-0 pointer-events-none z-[60]"
        style={{ width: '16px' }}
        aria-hidden="true"
      >
        {/* Marker track - positioned to align with scrollbar */}
        <div className="relative h-full w-full">
          {markers.map(marker => (
            <Tooltip key={marker.id}>
              <TooltipTrigger asChild>
                <div
                  className="absolute right-0.5 pointer-events-auto cursor-pointer transition-all duration-150 hover:scale-110"
                  style={{
                    top: `calc(${marker.percentage}% - 2%)`,
                    width: `${markerSize}px`,
                    height: `${markerSize}px`,
                    borderRadius: '50%',
                    backgroundColor: hoveredMarkerId === marker.id ? markerHoverColor : markerColor,
                    transform: 'translateY(-50%)',
                    opacity: hoveredMarkerId === marker.id ? 1 : 0.7,
                    boxShadow:
                      hoveredMarkerId === marker.id
                        ? '0 0 6px rgb(var(--color-primary) / 0.5)'
                        : 'none',
                  }}
                  onClick={() => handleMarkerClick(marker.percentage)}
                  onMouseEnter={() => setHoveredMarkerId(marker.id)}
                  onMouseLeave={() => setHoveredMarkerId(null)}
                />
              </TooltipTrigger>
              <TooltipContent
                side="left"
                sideOffset={12}
                className="bg-surface border border-border shadow-md rounded-md px-3 py-2"
              >
                <p className="text-sm max-w-[220px] break-words text-text-primary">
                  {marker.previewText}
                </p>
              </TooltipContent>
            </Tooltip>
          ))}

          {/* Scroll to bottom button - positioned near the bottom */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="absolute right-0.5 pointer-events-auto cursor-pointer transition-all duration-150 hover:scale-110 flex items-center justify-center"
                style={{
                  bottom: '16px',
                  width: `${markerSize}px`,
                  height: `${markerSize}px`,
                  borderRadius: '50%',
                  backgroundColor: markerColor,
                  opacity: 0.7,
                }}
                onClick={handleScrollToBottom}
                onMouseEnter={e => {
                  e.currentTarget.style.opacity = '1'
                  e.currentTarget.style.boxShadow = '0 0 6px rgb(var(--color-primary) / 0.5)'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.opacity = '0.7'
                  e.currentTarget.style.boxShadow = 'none'
                }}
              >
                <ChevronDown
                  className="text-white"
                  style={{ width: `${markerSize - 4}px`, height: `${markerSize - 4}px` }}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent
              side="left"
              sideOffset={12}
              className="bg-surface border border-border shadow-md rounded-md px-3 py-2"
            >
              <p className="text-sm text-text-primary">
                {t('scroll_to_bottom', { defaultValue: 'Scroll to bottom' })}
              </p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  )
}

export default ScrollbarMarkers
