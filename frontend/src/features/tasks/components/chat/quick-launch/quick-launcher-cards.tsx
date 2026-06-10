'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { useTranslation } from '@/hooks/useTranslation'

import type { QuickLauncher } from './types'

const CARD_WIDTH = 154
const CARD_GAP = 12
const SCROLL_STEP = (CARD_WIDTH + CARD_GAP) * 2
const SCROLL_TOLERANCE = 1

interface QuickLauncherCardsProps {
  systemLaunchers: QuickLauncher[]
  favoriteLaunchers: QuickLauncher[]
  selectedLauncherKey?: string | null
  onSelectLauncher: (launcher: QuickLauncher) => void
  renderMoreButton?: () => ReactNode
  renderQuickCreateCard?: () => ReactNode
}

function LauncherCard({
  launcher,
  isSelected,
  onClick,
}: {
  launcher: QuickLauncher
  isSelected: boolean
  onClick: () => void
}) {
  const description = launcher.description?.trim()

  return (
    <button
      type="button"
      data-testid={`quick-launcher-${launcher.type}-${launcher.key.replace(':', '-')}`}
      onClick={onClick}
      className={`group relative flex h-[78px] flex-col justify-center px-3 py-2 text-left transition-all duration-200 ${
        isSelected
          ? 'border-l-[3px] border-l-primary border-y border-r border-border bg-primary/5'
          : 'border border-border bg-base hover:bg-hover hover:shadow-[0_2px_12px_0_rgba(0,0,0,0.1)]'
      }`}
      style={{
        width: CARD_WIDTH,
        borderRadius: 20,
        flexShrink: 0,
      }}
    >
      <span
        className={`block truncate text-[15px] font-semibold leading-5 ${
          isSelected ? 'text-primary' : 'text-text-primary'
        }`}
        title={launcher.title}
      >
        {launcher.title}
      </span>
      {description && (
        <span className="mt-1 line-clamp-2 text-xs leading-4 text-text-muted" title={description}>
          {description}
        </span>
      )}
    </button>
  )
}

function LauncherScrollTrack({
  launchers,
  selectedLauncherKey,
  onSelectLauncher,
  testId,
}: {
  launchers: QuickLauncher[]
  selectedLauncherKey?: string | null
  onSelectLauncher: (launcher: QuickLauncher) => void
  testId: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const updateScrollButtons = useCallback(() => {
    const element = scrollRef.current

    if (!element) {
      return
    }

    setCanScrollLeft(element.scrollLeft > SCROLL_TOLERANCE)
    setCanScrollRight(
      element.scrollLeft + element.clientWidth < element.scrollWidth - SCROLL_TOLERANCE
    )
  }, [])

  useEffect(() => {
    const element = scrollRef.current

    if (!element) {
      return undefined
    }

    updateScrollButtons()
    element.addEventListener('scroll', updateScrollButtons, { passive: true })

    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateScrollButtons)
    resizeObserver?.observe(element)

    return () => {
      element.removeEventListener('scroll', updateScrollButtons)
      resizeObserver?.disconnect()
    }
  }, [launchers.length, updateScrollButtons])

  const handleScroll = (direction: -1 | 1) => {
    scrollRef.current?.scrollBy({
      left: direction * SCROLL_STEP,
      behavior: 'smooth',
    })
    window.requestAnimationFrame(updateScrollButtons)
  }

  return (
    <div className="relative min-w-0" data-testid={`${testId}-track`}>
      {canScrollLeft && (
        <button
          type="button"
          aria-label="Scroll left"
          className="absolute left-0 top-0 z-10 flex h-full w-12 items-center justify-start bg-gradient-to-r from-base via-base/90 to-transparent pl-1 text-text-muted transition-colors hover:text-text-primary"
          onClick={() => handleScroll(-1)}
          data-testid={`${testId}-scroll-left`}
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
      )}
      <div
        ref={scrollRef}
        className="scrollbar-hide flex min-w-0 w-full flex-nowrap items-center justify-start gap-3 overflow-x-auto overscroll-x-contain"
        data-testid={testId}
      >
        {launchers.map(launcher => (
          <LauncherCard
            key={launcher.key}
            launcher={launcher}
            isSelected={launcher.key === selectedLauncherKey}
            onClick={() => onSelectLauncher(launcher)}
          />
        ))}
      </div>
      {canScrollRight && (
        <button
          type="button"
          aria-label="Scroll right"
          className="absolute right-0 top-0 z-10 flex h-full w-12 items-center justify-end bg-gradient-to-l from-base via-base/90 to-transparent pr-1 text-text-muted transition-colors hover:text-text-primary"
          onClick={() => handleScroll(1)}
          data-testid={`${testId}-scroll-right`}
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      )}
    </div>
  )
}

export function QuickLauncherCards({
  systemLaunchers,
  favoriteLaunchers,
  selectedLauncherKey,
  onSelectLauncher,
  renderMoreButton,
  renderQuickCreateCard,
}: QuickLauncherCardsProps) {
  const { t } = useTranslation('chat')

  return (
    <div className="mx-auto mt-6 w-full max-w-[820px] space-y-3" data-testid="quick-launch-cards">
      {systemLaunchers.length > 0 && (
        <section className="space-y-2" data-testid="quick-launch-system-row">
          <h3 className="px-1 text-xs font-medium text-text-muted">
            {t('quick_launch.system_functions')}
          </h3>
          <LauncherScrollTrack
            launchers={systemLaunchers}
            selectedLauncherKey={selectedLauncherKey}
            onSelectLauncher={onSelectLauncher}
            testId="quick-launch-system-grid"
          />
        </section>
      )}

      {(favoriteLaunchers.length > 0 || renderMoreButton || renderQuickCreateCard) && (
        <section className="space-y-2" data-testid="quick-launch-favorites-row">
          <h3 className="px-1 text-xs font-medium text-text-muted">
            {t('quick_launch.favorite_agents')}
          </h3>
          <div className="flex items-center gap-3" data-testid="quick-launch-favorites-layout">
            {favoriteLaunchers.length > 0 && (
              <div className="min-w-0 flex-1">
                <LauncherScrollTrack
                  launchers={favoriteLaunchers}
                  selectedLauncherKey={selectedLauncherKey}
                  onSelectLauncher={onSelectLauncher}
                  testId="quick-launch-favorites-grid"
                />
              </div>
            )}
            {(renderMoreButton || renderQuickCreateCard) && (
              <div
                className="flex shrink-0 items-center gap-3"
                data-testid="quick-launch-favorites-actions"
              >
                {renderMoreButton?.()}
                {renderQuickCreateCard?.()}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
