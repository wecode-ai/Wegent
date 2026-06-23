// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getRuntimeConfigSync, type RuntimeConfig } from '@/lib/runtime-config'

export type CodingNavKey = 'code' | 'wework'

export interface CodingNavItem {
  key: CodingNavKey
  labelKey: 'common:navigation.code' | 'common:navigation.wework'
  href: string
  external: boolean
}

export function buildChatCodeHref(params?: URLSearchParams): string {
  const nextParams = new URLSearchParams(params?.toString())
  nextParams.set('agent', 'code')
  const query = nextParams.toString()
  return query ? `/chat?${query}` : '/chat?agent=code'
}

export function isExternalHref(href: string): boolean {
  return href.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(href)
}

function appendParamsToHref(href: string, params?: URLSearchParams): string {
  if (!params || Array.from(params.keys()).length === 0) {
    return href
  }

  if (isExternalHref(href)) {
    try {
      const url = new URL(href)
      params.forEach((value, key) => {
        url.searchParams.set(key, value)
      })
      return url.toString()
    } catch {
      const separator = href.includes('?') ? '&' : '?'
      return `${href}${separator}${params.toString()}`
    }
  }

  const separator = href.includes('?') ? '&' : '?'
  return `${href}${separator}${params.toString()}`
}

export function getCodingEntryHref(
  config: RuntimeConfig = getRuntimeConfigSync(),
  params?: URLSearchParams
): string {
  const weworkCodeUrl = config.weworkCodeUrl.trim()
  if (weworkCodeUrl) {
    return appendParamsToHref(weworkCodeUrl, params)
  }

  return buildChatCodeHref(params)
}

export function getCodingNavItem(config: RuntimeConfig = getRuntimeConfigSync()): CodingNavItem {
  const href = getCodingEntryHref(config)
  const external = isExternalHref(href)

  if (config.weworkCodeUrl.trim()) {
    return {
      key: 'wework',
      labelKey: 'common:navigation.wework',
      href,
      external,
    }
  }

  return {
    key: 'code',
    labelKey: 'common:navigation.code',
    href,
    external,
  }
}

export function openNavigationHref(router: { push: (href: string) => void }, href: string): void {
  if (isExternalHref(href) && typeof window !== 'undefined') {
    window.location.href = href
    return
  }

  router.push(href)
}
