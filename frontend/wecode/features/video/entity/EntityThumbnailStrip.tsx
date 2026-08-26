// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRef, useEffect, useState, useCallback } from 'react'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

/** Minimal interface for thumbnail strip items — any type with these fields can be used */
export interface ThumbnailItem {
  id: number
  image_url: string
  entity_name: string
  isGenerating?: boolean
  hasPendingGeneration?: boolean
}

interface EntityThumbnailStripProps {
  entities: ThumbnailItem[]
  activeIndex: number
  onSelectIndex: (index: number) => void
  thumbWidth?: number
  thumbHeight?: number
}

export function EntityThumbnailStrip({
  entities,
  activeIndex,
  onSelectIndex,
  thumbWidth = 72,
  thumbHeight = 48,
}: EntityThumbnailStripProps) {
  const { t } = useTranslation('video')
  const scrollRef = useRef<HTMLDivElement>(null)

  // Check overflow state for both directions
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const checkOverflow = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 4)
    setCanScrollRight(el.scrollWidth > el.clientWidth + el.scrollLeft + 4)
  }, [])

  useEffect(() => {
    checkOverflow()
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', checkOverflow, { passive: true })
    window.addEventListener('resize', checkOverflow)
    return () => {
      el.removeEventListener('scroll', checkOverflow)
      window.removeEventListener('resize', checkOverflow)
    }
  }, [checkOverflow, entities.length])

  // Scroll active item into view
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const activeChild = el.children[activeIndex] as HTMLElement | undefined
    if (activeChild) {
      activeChild.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' })
    }
    // Re-check overflow after scroll
    setTimeout(checkOverflow, 300)
  }, [activeIndex, checkOverflow])

  const handleScrollLeft = () => {
    const el = scrollRef.current
    if (!el) return
    el.scrollBy({ left: -200, behavior: 'smooth' })
  }

  const handleScrollRight = () => {
    const el = scrollRef.current
    if (!el) return
    el.scrollBy({ left: 200, behavior: 'smooth' })
  }

  if (entities.length === 0) return null

  return (
    <div className="relative">
      {/* Scrollable thumbnail container */}
      <div
        ref={scrollRef}
        className="flex gap-1 overflow-x-auto scrollbar-hide"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {entities.map((entity, index) => {
          const isActive = index === activeIndex
          const isPending = Boolean(entity.hasPendingGeneration)

          return (
            <button
              key={entity.id}
              onClick={() => onSelectIndex(index)}
              className={`flex-shrink-0 overflow-hidden transition-all ${
                isPending
                  ? isActive
                    ? 'rounded-[8px] border border-[#ff8200]'
                    : 'rounded-[6px] border border-black/10 bg-[#F7F7F7]'
                  : isActive
                    ? 'border border-[#ff8200] rounded-[8px] opacity-100 shadow-md'
                    : 'opacity-50 border border-black/10 rounded-[6px] hover:opacity-75'
              }`}
              style={{
                width: thumbWidth,
                height: thumbHeight,
                ...(isPending && isActive
                  ? {
                      background: 'rgba(255, 130, 0, 0.05)',
                    }
                  : {}),
              }}
            >
              {isPending ? (
                <div className="flex h-full w-full items-center justify-center">
                  <span
                    className={`text-[14px] font-normal leading-5 ${
                      isActive ? 'text-[rgba(255,130,0,0.8)]' : 'text-[#BDBDBD]'
                    }`}
                    style={{ fontFamily: "'PingFang SC', sans-serif" }}
                  >
                    待生成
                  </span>
                </div>
              ) : entity.isGenerating ? (
                // Generating state: show image with overlay if available, otherwise plain generating UI
                <div className="w-full h-full relative">
                  {entity.image_url && (
                    <img
                      src={entity.image_url}
                      alt={entity.entity_name}
                      className="w-full h-full object-cover"
                    />
                  )}
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                    <Loader2 className="w-4 h-4 animate-spin text-white" />
                  </div>
                </div>
              ) : entity.image_url ? (
                <img
                  src={entity.image_url}
                  alt={entity.entity_name}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full bg-gray-100 flex items-center justify-center">
                  <span className="text-[10px] text-gray-400">{t('no_content')}</span>
                </div>
              )}
            </button>
          )
        })}
      </div>

      {/* Left gradient + scroll button */}
      {canScrollLeft && (
        <>
          <div
            className="absolute left-0 top-0 w-[32px] pointer-events-none"
            style={{
              background: 'linear-gradient(to left, transparent, white)',
              height: thumbHeight,
            }}
          />
          <button
            onClick={handleScrollLeft}
            className="absolute left-0 top-1/2 -translate-y-1/2 w-[22px] h-[22px] rounded-[6px] bg-white border border-[#eeeeee] flex items-center justify-center hover:bg-gray-50 shadow-md"
          >
            <ChevronLeft className="w-3.5 h-3.5 text-[#333333]" />
          </button>
        </>
      )}

      {/* Right gradient + scroll button */}
      {canScrollRight && (
        <>
          <div
            className="absolute right-0 top-0 w-[32px] pointer-events-none"
            style={{
              background: 'linear-gradient(to right, transparent, white)',
              height: thumbHeight,
            }}
          />
          <button
            onClick={handleScrollRight}
            className="absolute right-0 top-1/2 -translate-y-1/2 w-[22px] h-[22px] rounded-[6px] bg-white border border-[#eeeeee] flex items-center justify-center hover:bg-gray-50 shadow-md"
          >
            <ChevronRight className="w-3.5 h-3.5 text-[#333333]" />
          </button>
        </>
      )}
    </div>
  )
}
