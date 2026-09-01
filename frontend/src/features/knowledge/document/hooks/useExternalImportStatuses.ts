// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react'
import {
  getExternalDocumentImportStatuses,
  type ExternalDocumentImportStatuses,
} from '@/apis/knowledge'

interface StatusSnapshot {
  knowledgeBaseId: number
  resourceIds: string[]
  statuses: ExternalDocumentImportStatuses
  phase: 'loading' | 'ready' | 'error'
}

export function useExternalImportStatuses(knowledgeBaseId: number, resourceIds: string[]) {
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null)
  const [revision, setRevision] = useState(0)
  const retry = useCallback(() => setRevision(current => current + 1), [])

  useEffect(() => {
    let cancelled = false
    const context = { knowledgeBaseId, resourceIds }
    if (!resourceIds.length) {
      setSnapshot({ ...context, statuses: {}, phase: 'ready' })
      return
    }
    setSnapshot({ ...context, statuses: {}, phase: 'loading' })
    getExternalDocumentImportStatuses(knowledgeBaseId, 'dingtalk', resourceIds).then(
      statuses => {
        if (!cancelled) setSnapshot({ ...context, statuses, phase: 'ready' })
      },
      () => {
        if (!cancelled) setSnapshot({ ...context, statuses: {}, phase: 'error' })
      }
    )
    return () => {
      cancelled = true
    }
  }, [knowledgeBaseId, resourceIds, revision])

  // Never show a previous KB/directory's status while the next request is starting.
  const current =
    snapshot?.knowledgeBaseId === knowledgeBaseId && snapshot.resourceIds === resourceIds
      ? snapshot
      : null
  return {
    statuses: current?.statuses ?? {},
    loading: resourceIds.length > 0 && (!current || current.phase === 'loading'),
    failed: current?.phase === 'error',
    retry,
  }
}
