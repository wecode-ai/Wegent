// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { paths } from '@/config/paths'
import { useTranslation } from '@/hooks/useTranslation'
import { getRuntimeConfigSync } from '@/lib/runtime-config'
import { getCodingNavItem, openNavigationHref } from '@/config/coding-route'

interface DesktopNavLinksProps {
  activePage: 'chat' | 'code' | 'wiki' | 'flow' | 'dashboard'
}

export function DesktopNavLinks({ activePage }: DesktopNavLinksProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Check if Wiki module is enabled via runtime config
  const runtimeConfig = getRuntimeConfigSync()
  const isWikiEnabled = runtimeConfig.enableWiki
  const codingNavItem = getCodingNavItem(runtimeConfig)

  const indicatorContainerRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [indicatorStyle, setIndicatorStyle] = useState({ width: 0, left: 0 })

  // Prefetch all navigation pages on mount for smoother navigation
  useEffect(() => {
    router.prefetch(paths.chat.getHref())
    if (!codingNavItem.external) {
      router.prefetch(codingNavItem.href)
    }
    router.prefetch(paths.feed.getHref())
    if (isWikiEnabled) {
      router.prefetch(paths.wiki.getHref())
    }
  }, [router, isWikiEnabled, codingNavItem.external, codingNavItem.href])

  const navItems = useMemo(
    () => [
      {
        key: 'chat' as const,
        label: t('common:navigation.chat'),
        onClick: () => {
          startTransition(() => {
            router.push(paths.chat.getHref())
          })
        },
      },
      {
        key: codingNavItem.key,
        label: t(codingNavItem.labelKey),
        onClick: () => {
          startTransition(() => {
            openNavigationHref(router, codingNavItem.href)
          })
        },
      },
      {
        key: 'flow' as const,
        label: t('common:navigation.flow'),
        onClick: () => {
          startTransition(() => {
            router.push(paths.feed.getHref())
          })
        },
      },
      ...(isWikiEnabled
        ? [
            {
              key: 'wiki' as const,
              label: t('common:navigation.wiki'),
              onClick: () => {
                startTransition(() => {
                  router.push(paths.wiki.getHref())
                })
              },
            },
          ]
        : []),
    ],
    [
      t,
      router,
      startTransition,
      isWikiEnabled,
      codingNavItem.href,
      codingNavItem.key,
      codingNavItem.labelKey,
    ]
  )

  useEffect(() => {
    const updateIndicator = () => {
      const container = indicatorContainerRef.current
      const current = itemRefs.current[activePage]

      if (!container || !current) {
        setIndicatorStyle(prev =>
          prev.width === 0 && prev.left === 0 ? prev : { width: 0, left: 0 }
        )
        return
      }

      const containerRect = container.getBoundingClientRect()
      const currentRect = current.getBoundingClientRect()
      setIndicatorStyle({
        width: currentRect.width,
        left: currentRect.left - containerRect.left,
      })
    }

    updateIndicator()
    window.addEventListener('resize', updateIndicator)

    return () => {
      window.removeEventListener('resize', updateIndicator)
    }
  }, [activePage, navItems])

  return (
    <div
      ref={indicatorContainerRef}
      className="relative flex items-center gap-4 sm:gap-6"
      data-tour="mode-toggle"
    >
      <span
        className="pointer-events-none absolute bottom-0 h-0.5 rounded-full bg-primary transition-all duration-300 ease-out"
        style={{
          width: indicatorStyle.width,
          transform: `translateX(${indicatorStyle.left}px)`,
          opacity: indicatorStyle.width ? 1 : 0,
        }}
        aria-hidden="true"
      />
      {navItems.map(item => (
        <button
          key={item.key}
          type="button"
          ref={element => {
            itemRefs.current[item.key] = element
          }}
          onClick={item.onClick}
          disabled={isPending}
          className={`relative px-1 py-1 text-base font-bold leading-none transition-colors duration-200 ${
            activePage === item.key
              ? 'text-text-primary'
              : 'text-text-muted hover:text-text-primary'
          } ${isPending ? 'opacity-70' : ''}`}
          aria-current={activePage === item.key ? 'page' : undefined}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
