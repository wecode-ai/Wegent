// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react'
import client from '@/apis/client'
import type { BatchDeletionResult } from '@/apis/knowledge'
import { useTranslation } from '@/hooks/useTranslation'

interface BatchDeletionOptions {
  scope: string
  run: (ids: number[], continuing: boolean) => Promise<BatchDeletionResult | null>
  onResult: (result: BatchDeletionResult, aggregate: BatchDeletionResult) => void
}

function mergeResults(
  previous: BatchDeletionResult | null,
  next: BatchDeletionResult
): BatchDeletionResult {
  const items = new Map(previous?.items.map(item => [item.document_id, item]) ?? [])
  next.items.forEach(item => items.set(item.document_id, item))
  const outcomes = [...items.values()]
  const failedIds = outcomes.filter(item => !item.content_deleted).map(item => item.document_id)
  return {
    items: outcomes,
    failed_ids: failedIds,
    failed_count: failedIds.length,
    success_count: outcomes.length - failedIds.length,
    unconfirmed_count: outcomes.filter(
      item => item.content_deleted && item.index_cleanup === 'unconfirmed'
    ).length,
    message: 'Batch deletion processed',
  }
}

export function useBatchDeletion(options: BatchDeletionOptions) {
  const { t } = useTranslation('knowledge')
  const cacheScope = client.getCacheScope()
  const scope = JSON.stringify([options.scope, cacheScope])
  const latest = useRef(options)
  latest.current = options
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const version = useRef(0)
  const invalidate = useCallback(() => {
    version.current++
  }, [])
  const pending = useRef(false)
  const [state, setState] = useState<{
    scope: string
    result: BatchDeletionResult | null
    loading: boolean
    error: string | null
  }>({ scope, result: null, loading: false, error: null })
  const visible = state.scope === scope ? state : { result: null, loading: false, error: null }

  useEffect(() => {
    invalidate()
    pending.current = false
    setState({ scope, result: null, loading: false, error: null })
    return invalidate
  }, [scope, invalidate])

  const perform = async (
    ids: number[],
    previous: BatchDeletionResult | null,
    continuing: boolean
  ) => {
    if (pending.current || scopeRef.current !== scope || client.getCacheScope() !== cacheScope)
      return
    pending.current = true
    const requestVersion = ++version.current
    const current = () =>
      version.current === requestVersion &&
      scopeRef.current === scope &&
      client.getCacheScope() === cacheScope
    setState({ scope, result: previous, loading: true, error: null })
    try {
      const result = await latest.current.run([...new Set(ids)], continuing)
      if (!current() || result === null) return
      const aggregate = mergeResults(previous, result)
      setState({ scope, result: aggregate, loading: false, error: null })
      latest.current.onResult(result, aggregate)
    } catch {
      if (!current()) return
      setState({
        scope,
        loading: false,
        result: previous
          ? { ...previous, items: previous.items.map(item => ({ ...item, can_continue: false })) }
          : null,
        error: t('document.deletion.batchRequestFailed'),
      })
    } finally {
      if (current()) {
        pending.current = false
        setState(previousState => ({ ...previousState, loading: false }))
      }
    }
  }

  const close = () => {
    if (pending.current || scopeRef.current !== scope) return
    version.current++
    setState({ scope, result: null, loading: false, error: null })
  }
  const continueDeletion = () => {
    const ids =
      visible.result?.items
        .filter(item => !item.content_deleted && item.can_continue)
        .map(item => item.document_id) ?? []
    if (ids.length) return perform(ids, visible.result, true)
  }
  return {
    ...visible,
    start: (ids: number[]) => perform(ids, null, false),
    continueDeletion,
    close,
  }
}
