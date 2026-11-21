// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { apiClient, ApiError } from '@/apis/client'
import { isCitationDenied, isSourceHidden } from './sourceAccess'
import {
  getReadFailure,
  matchesCitation,
  readEvidenceSnapshot,
  type AnswerCitation,
  type EvidenceScope,
  type EvidenceSnapshot,
  type ReadFailure,
} from './evidenceRead'

export type EvidenceEntry = { citation: AnswerCitation; number: number }

type Selection = {
  entry: EvidenceEntry
  anchor: HTMLButtonElement
} & ({ kind: 'preview'; anchorId: string } | { kind: 'panel' })

export type EvidenceRead = Selection & { scope: string } & (
    | { status: 'loading' }
    | { status: 'ready'; snapshot: EvidenceSnapshot }
    | { status: 'error'; failure: ReadFailure }
  )

export function useEvidenceRead(evidence: EvidenceScope, scope: string) {
  const [read, setRead] = useState<EvidenceRead>()
  const active = useRef<{ selection: Selection; controller: AbortController } | null>(null)
  const cacheScope = apiClient.getCacheScope()
  const cancel = useCallback(() => {
    active.current?.controller.abort()
    active.current = null
  }, [])
  useLayoutEffect(() => cancel, [cancel])

  const clear = useCallback(() => {
    cancel()
    setRead(undefined)
  }, [cancel])

  const isHidden = (entry: EvidenceEntry) =>
    evidence.visitOnly || isSourceHidden(evidence.sourceAccess?.[entry.citation.knowledge_base_id])

  const rejectSnapshot = (error: unknown, selection: Selection) => {
    const { citation } = selection.entry
    if (isCitationDenied(error, 'answer') && !evidence.shared) {
      clear()
      evidence.onAnswerDenied?.()
      return
    }
    if (isCitationDenied(error, 'source') && evidence.onSourceDenied) {
      cancel()
      evidence.onSourceDenied(citation.knowledge_base_id)
      return
    }

    const failure = getReadFailure(error, 'read_failed')
    setRead({ ...selection, scope, status: 'error', failure })
    if (failure.key === 'unavailable') evidence.onCitationUnavailable?.(citation.citation_id)
  }

  const start = async (selection: Selection, retry = false) => {
    const { entry, kind, anchor } = selection
    const { citation } = entry
    if (
      apiClient.getCacheScope() !== cacheScope ||
      isHidden(entry) ||
      evidence.unavailableCitations?.has(citation.citation_id)
    )
      return
    const previous = active.current?.selection
    if (
      !retry &&
      previous?.entry.citation.citation_id === citation.citation_id &&
      previous.kind === kind &&
      (kind === 'panel' || previous.anchor === anchor)
    ) {
      previous.anchor = anchor
      return
    }

    cancel()
    const request = { selection, controller: new AbortController() }
    active.current = request
    const pending = { ...selection, scope }
    setRead({ ...pending, status: 'loading' })
    const current = () => active.current === request && apiClient.getCacheScope() === cacheScope

    try {
      const snapshot = await readEvidenceSnapshot(evidence, citation, request.controller.signal)
      if (!current()) return
      if (!matchesCitation(snapshot, citation)) throw new ApiError('Citation unavailable', 404)
      setRead({ ...pending, status: 'ready', snapshot })
    } catch (error) {
      if (current()) rejectSnapshot(error, selection)
    }
  }

  const hidden = read && isHidden(read.entry)
  const unavailable = read && evidence.unavailableCitations?.has(read.entry.citation.citation_id)
  const invalidated =
    read?.scope !== undefined && read.scope !== scope
      ? 'scope'
      : hidden || (unavailable && read?.status !== 'error')
        ? 'access'
        : undefined
  return { active, read: invalidated ? undefined : read, invalidated, start, clear, rejectSnapshot }
}
