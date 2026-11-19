// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext, useMemo, useState, type ComponentProps } from 'react'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import { useTranslation } from '@/hooks/useTranslation'
import { shouldHideAnswerMarker } from '../../../utils/answerEvidenceMarkers'
import { AnswerEvidenceContext } from './AnswerEvidenceContext'
import { CitationCapsule } from './CitationCapsule'
import { evidenceRemark } from './evidenceRemark'

const MarkerToken = createContext('')

function CitationMarker({
  citationId,
  evidenceToken,
}: {
  citationId?: string
  evidenceToken?: string
}) {
  const token = useContext(MarkerToken)
  const interaction = useContext(AnswerEvidenceContext)
  const { t } = useTranslation('chat')
  if (!interaction || evidenceToken !== token) return null
  if (shouldHideAnswerMarker(citationId, interaction.evidence)) return null

  const entry = citationId ? interaction.entries.get(citationId) : undefined
  return entry && !interaction.evidence.unavailableCitations?.has(entry.citation.citation_id) ? (
    <CitationCapsule entry={entry} />
  ) : (
    <span data-testid="answer-evidence-unavailable" className="text-text-muted">
      {t('evidence.unavailable')}
    </span>
  )
}

export function CitationMarkup({ components, ...props }: ComponentProps<typeof EnhancedMarkdown>) {
  const streaming = useContext(AnswerEvidenceContext)?.evidence.streaming
  const [token] = useState(() => Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-'))
  const remarkPlugins = useMemo(() => [() => evidenceRemark(token, streaming)], [token, streaming])
  const renderers = useMemo(
    () => ({ ...components, 'answer-citation': CitationMarker }),
    [components]
  )

  return (
    <MarkerToken.Provider value={token}>
      <EnhancedMarkdown {...props} components={renderers} remarkPlugins={remarkPlugins} />
    </MarkerToken.Provider>
  )
}
