// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createContext } from 'react'
import type { EvidenceScope } from './evidenceRead'
import type { EvidenceEntry, EvidenceRead } from './useEvidenceRead'

export const AnswerEvidenceContext = createContext<{
  scope: string
  evidence: EvidenceScope
  entries: ReadonlyMap<string, EvidenceEntry>
  read?: EvidenceRead
  openPanel: (entry: EvidenceEntry, anchor: HTMLButtonElement) => void
  openPreview: (entry: EvidenceEntry, anchor: HTMLButtonElement, anchorId: string) => void
  closePreview: (anchor: HTMLButtonElement | null) => void
  retryPreview: () => void
  isRestoringFocus: (anchor: HTMLButtonElement) => boolean
} | null>(null)
