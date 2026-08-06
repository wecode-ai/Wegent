// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react'

import { userApis } from '@/apis/user'
import { buildTeamTargetHref } from '@/features/tasks/components/selector/team-selector-utils'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { QuickLaunchFunction } from '@/types/api'
import { ResourceIcon } from './ResourceIcon'

const FALLBACK_BACKGROUNDS = [
  'bg-gradient-to-br from-orange-50 via-surface to-amber-100/80',
  'bg-gradient-to-br from-blue-50 via-surface to-indigo-100/80',
  'bg-gradient-to-br from-violet-50 via-surface to-purple-100/80',
  'bg-gradient-to-br from-emerald-50 via-surface to-teal-100/80',
  'bg-gradient-to-br from-rose-50 via-surface to-pink-100/80',
  'bg-gradient-to-br from-cyan-50 via-surface to-sky-100/80',
] as const
const CARD_SCROLL_STEP = 292
const SCROLL_TOLERANCE = 1

function getFallbackBackground(id: string) {
  const hash = Array.from(id).reduce(
    (value, character) => (value * 31 + (character.codePointAt(0) || 0)) >>> 0,
    0
  )
  return FALLBACK_BACKGROUNDS[hash % FALLBACK_BACKGROUNDS.length]
}

function getAgentHref(agent: QuickLaunchFunction, presetId?: string) {
  const params = new URLSearchParams([
    ['teamId', String(agent.team_id)],
    ['quickLauncher', `system:${agent.id}`],
  ])
  if (presetId) {
    params.set('quickPreset', presetId)
  } else if (agent.input_presets.length > 0) {
    params.set('showPresets', '1')
  }
  const targetPage = agent.recommended_mode === 'code' ? 'code' : 'chat'
  return buildTeamTargetHref(targetPage, params)
}

export function FeaturedScenarios() {
  const router = useRouter()
  const { t } = useTranslation('resource-library')
  const [agents, setAgents] = useState<QuickLaunchFunction[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const updateScrollButtons = useCallback(() => {
    const element = scrollRef.current
    if (!element) return

    setCanScrollLeft(element.scrollLeft > SCROLL_TOLERANCE)
    setCanScrollRight(
      element.scrollLeft + element.clientWidth < element.scrollWidth - SCROLL_TOLERANCE
    )
  }, [])

  useEffect(() => {
    let active = true

    const loadRecommendedAgents = async () => {
      try {
        const response = await userApis.getQuickLaunch()
        if (active) setAgents(response.system_functions)
      } catch {
        if (active) setAgents([])
      } finally {
        if (active) setIsLoading(false)
      }
    }

    void loadRecommendedAgents()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return undefined

    updateScrollButtons()
    element.addEventListener('scroll', updateScrollButtons, { passive: true })
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateScrollButtons)
    resizeObserver?.observe(element)

    return () => {
      element.removeEventListener('scroll', updateScrollButtons)
      resizeObserver?.disconnect()
    }
  }, [agents.length, updateScrollButtons])

  if (isLoading || agents.length === 0) return null

  const handleScroll = (direction: -1 | 1) => {
    scrollRef.current?.scrollBy({
      left: direction * CARD_SCROLL_STEP,
      behavior: 'smooth',
    })
    window.requestAnimationFrame(updateScrollButtons)
  }

  return (
    <section className="pb-5" data-testid="featured-scenarios">
      <h2 className="mb-2.5 text-base font-semibold tracking-tight text-text-primary">
        {t('featured_scenarios.title')}
      </h2>

      <div className="relative min-w-0">
        {canScrollLeft && (
          <>
            <span
              className="pointer-events-none absolute bottom-1 left-0 top-1 z-10 w-10 bg-gradient-to-r from-base via-base/70 to-transparent"
              aria-hidden
            />
            <button
              type="button"
              aria-label={t('featured_scenarios.scroll_left')}
              className="absolute left-1.5 top-1/2 z-20 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-border/70 bg-surface/95 text-text-secondary shadow-md backdrop-blur-sm transition hover:scale-105 hover:text-text-primary hover:shadow-lg md:h-6 md:w-6"
              onClick={() => handleScroll(-1)}
              data-testid="featured-scenarios-scroll-left"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
            </button>
          </>
        )}
        <div
          ref={scrollRef}
          className="scrollbar-hide flex snap-x snap-mandatory items-start gap-3 overflow-x-auto pb-1 pt-1"
          aria-label={t('featured_scenarios.title')}
          data-testid="featured-scenarios-scroll"
        >
          {agents.map(agent => {
            const examples = agent.input_presets.slice(0, 2)
            const cover = agent.cover?.trim() || null

            return (
              <article
                key={agent.id}
                className="relative isolate w-[280px] shrink-0 snap-start overflow-hidden rounded-xl border border-border bg-surface shadow-sm transition-[border-color,box-shadow] duration-200 hover:border-primary/25 hover:shadow-md"
                data-testid={`featured-agent-${agent.id}`}
              >
                {cover && (
                  <>
                    {/* System-configured scenario covers are internal or administrator-approved assets. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={cover}
                      alt=""
                      className="absolute inset-0 -z-20 h-full w-full object-cover opacity-60"
                      aria-hidden="true"
                      onError={event => {
                        event.currentTarget.style.display = 'none'
                      }}
                      data-testid={`featured-agent-${agent.id}-cover`}
                    />
                    <span
                      className="absolute inset-0 -z-10 bg-gradient-to-b from-white/20 via-surface/80 to-surface"
                      aria-hidden="true"
                    />
                  </>
                )}

                <button
                  type="button"
                  className={cn(
                    'group relative flex w-full items-start overflow-hidden px-3 pb-2 pt-3 text-left',
                    !cover && getFallbackBackground(agent.id)
                  )}
                  onClick={() => router.push(getAgentHref(agent))}
                  data-testid={`featured-agent-${agent.id}-open`}
                >
                  <span className="relative z-10 flex min-w-0 flex-1 items-start gap-3">
                    <ResourceIcon
                      resourceType="agent"
                      name={agent.title}
                      icon={agent.icon}
                      size="md"
                      className={cn('shadow-sm', cover && 'ring-2 ring-white/80')}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          'line-clamp-2 font-semibold',
                          cover ? 'text-base' : 'text-sm',
                          'text-text-primary'
                        )}
                        title={agent.title}
                      >
                        {agent.title}
                      </span>
                    </span>
                  </span>
                </button>

                {examples.length > 0 && (
                  <div className="relative z-10 px-3 pb-3 pt-0.5">
                    <p className="mb-1 text-[10px] font-medium text-text-muted">
                      {t('featured_scenarios.try_asking')}
                    </p>
                    <div className="flex flex-col gap-1">
                      {examples.map(example => (
                        <button
                          key={example.id}
                          type="button"
                          className={cn(
                            'group/example flex min-h-8 w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[11px] text-text-secondary transition-colors hover:text-text-primary',
                            cover
                              ? 'bg-white/75 backdrop-blur-sm hover:bg-white/90'
                              : 'bg-base hover:bg-primary/[0.06]'
                          )}
                          onClick={() => router.push(getAgentHref(agent, example.id))}
                          data-testid={`featured-agent-${agent.id}-example-${example.id}`}
                        >
                          <span className="min-w-0 flex-1 truncate" title={example.title}>
                            {example.title}
                          </span>
                          <ArrowRight
                            className="h-3 w-3 shrink-0 text-text-muted transition-transform group-hover/example:translate-x-0.5 group-hover/example:text-primary"
                            aria-hidden
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </article>
            )
          })}
        </div>
        {canScrollRight && (
          <>
            <span
              className="pointer-events-none absolute bottom-1 right-0 top-1 z-10 w-10 bg-gradient-to-l from-base via-base/70 to-transparent"
              aria-hidden
            />
            <button
              type="button"
              aria-label={t('featured_scenarios.scroll_right')}
              className="absolute right-1.5 top-1/2 z-20 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-border/70 bg-surface/95 text-text-secondary shadow-md backdrop-blur-sm transition hover:scale-105 hover:text-text-primary hover:shadow-lg md:h-6 md:w-6"
              onClick={() => handleScroll(1)}
              data-testid="featured-scenarios-scroll-right"
            >
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          </>
        )}
      </div>
    </section>
  )
}
