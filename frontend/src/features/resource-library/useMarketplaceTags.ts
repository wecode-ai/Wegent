// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import type { MarketplaceTag } from '@/types/marketplace'

export function getMarketplaceTagLabel(tag: MarketplaceTag, language: string): string {
  return language.startsWith('zh') ? tag.name_zh : tag.name_en
}

export function useMarketplaceTags(enabled = true) {
  const [items, setItems] = useState<MarketplaceTag[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState(false)
  const requestIdRef = useRef(0)

  const reload = useCallback(async () => {
    const requestId = ++requestIdRef.current
    if (!enabled) {
      setItems([])
      setLoading(false)
      setError(false)
      return
    }
    setLoading(true)
    setError(false)
    try {
      const response = await resourceLibraryApi.getMarketplaceTags()
      if (requestId !== requestIdRef.current) return
      setItems([...response.items].sort((left, right) => left.sort - right.sort))
    } catch {
      if (requestId !== requestIdRef.current) return
      setItems([])
      setError(true)
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    void reload()
  }, [reload])

  return { items, loading, error, reload }
}
