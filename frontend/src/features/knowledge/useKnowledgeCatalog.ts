// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import {
  getKnowledgeCatalogPage,
  type KnowledgeCatalogFilters,
  type KnowledgeCatalogPage,
} from '@/apis/knowledge'

interface CatalogState {
  key: string
  page: KnowledgeCatalogPage | null
  pending: boolean
  failed: boolean
}

export function useKnowledgeCatalog(
  filters: KnowledgeCatalogFilters,
  accountId: number | undefined,
  revision = 0
) {
  const params = JSON.stringify({ ...filters, query: filters.query.trim() })
  const key = JSON.stringify([accountId, params, revision])
  const [state, setState] = useState<CatalogState | null>(null)
  const [request, setRequest] = useState({ key: '', offset: 0, attempt: 0 })
  if (request.key !== key) setRequest({ key, offset: 0, attempt: 0 })
  const offset = request.key === key ? request.offset : 0
  const attempt = request.key === key ? request.attempt : 0

  useEffect(() => {
    if (accountId === undefined) return
    const controller = new AbortController()
    setState(previous => ({
      key,
      page: previous?.key === key ? previous.page : null,
      pending: true,
      failed: false,
    }))
    const timer = setTimeout(
      () => {
        getKnowledgeCatalogPage(JSON.parse(params), offset, controller.signal)
          .then(page => {
            if (controller.signal.aborted) return
            setState(previous => {
              if (previous?.key !== key) return previous
              const items =
                offset > 0 ? [...(previous.page?.items ?? []), ...page.items] : page.items
              return {
                key,
                page: {
                  ...page,
                  items: Array.from(new Map(items.map(row => [row.id, row])).values()),
                },
                pending: false,
                failed: false,
              }
            })
          })
          .catch(() => {
            if (controller.signal.aborted) return
            setState(previous =>
              previous?.key === key ? { ...previous, pending: false, failed: true } : previous
            )
          })
      },
      offset === 0 ? 180 : 0
    )
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [accountId, attempt, key, offset, params])

  const current = state?.key === key ? state : null
  const page = current?.page ?? null
  return {
    page,
    pending: accountId !== undefined && (current?.pending ?? true),
    failed: current?.failed ?? false,
    retry: () => setRequest({ key, offset, attempt: attempt + 1 }),
    loadMore: () => {
      if (page?.has_more && !current?.pending && !current?.failed) {
        setRequest({ key, offset: page.offset + page.returned_count, attempt: 0 })
      }
    },
  }
}
