// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from 'react'

import { modelApis, type ModelCategoryType, type UnifiedModel } from '@/apis/models'

interface ModelQuery {
  shellName: string
  scope?: 'personal' | 'group' | 'all'
  groupName?: string
  category: ModelCategoryType
}

interface ModelResult {
  query: ModelQuery
  models: UnifiedModel[] | null
  shellChanged: boolean
}

export function useShellModels({
  enabled,
  shellName,
  scope,
  groupName,
  category,
  onError,
}: Omit<ModelQuery, 'shellName'> & {
  enabled: boolean
  shellName?: string
  onError: () => void
}) {
  const query = useMemo(
    () => (enabled && shellName ? { shellName, scope, groupName, category } : null),
    [enabled, shellName, scope, groupName, category]
  )
  const [result, setResult] = useState<ModelResult | null>(null)
  const previousShell = useRef<string | null>(null)
  const shellChangePending = useRef(false)

  useEffect(() => {
    if (!query) {
      previousShell.current = null
      shellChangePending.current = false
      return
    }

    let cancelled = false
    if (previousShell.current !== null && previousShell.current !== query.shellName) {
      shellChangePending.current = true
    }
    const shellChanged = shellChangePending.current
    previousShell.current = query.shellName

    modelApis
      .getUnifiedModels(query.shellName, false, query.scope, query.groupName, query.category)
      .then(response => {
        if (!cancelled) {
          setResult({ query, models: response.data, shellChanged })
          shellChangePending.current = false
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResult({ query, models: null, shellChanged })
          onError()
        }
      })

    return () => {
      cancelled = true
    }
  }, [query, onError])

  const currentResult = query && result?.query === query ? result : null
  return {
    models: currentResult?.models ?? [],
    isLoading: Boolean(query && !currentResult),
    hasLoaded: Boolean(currentResult?.models),
    shellChanged: currentResult?.shellChanged ?? false,
  }
}
