// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import { getShowAdvancedKnowledge, saveShowAdvancedKnowledge } from '@/utils/userPreferences'
import type { KnowledgeBaseType } from '@/types/knowledge'

export function isAdvancedKnowledgeBase(kbType: KnowledgeBaseType | null | undefined): boolean {
  return kbType === 'code_wiki'
}

export function filterKnowledgeBasesByAdvancedMode<T extends { kb_type?: KnowledgeBaseType }>(
  knowledgeBases: T[],
  showAdvancedKnowledge: boolean
): T[] {
  return showAdvancedKnowledge
    ? knowledgeBases
    : knowledgeBases.filter(kb => !isAdvancedKnowledgeBase(kb.kb_type))
}

/**
 * Persisted visibility toggle for advanced knowledge bases (code wikis).
 * Mirrors useAdvancedDeviceMode: a pure client-side localStorage preference,
 * defaulting to hidden. Filtering is display-only and never touches data.
 */
export function useAdvancedKnowledgeMode() {
  const [showAdvancedKnowledge, setShowAdvancedKnowledgeState] = useState(false)
  const [isAdvancedKnowledgeModeReady, setIsAdvancedKnowledgeModeReady] = useState(false)

  useEffect(() => {
    setShowAdvancedKnowledgeState(getShowAdvancedKnowledge())
    setIsAdvancedKnowledgeModeReady(true)
  }, [])

  const setShowAdvancedKnowledge = useCallback((show: boolean) => {
    setShowAdvancedKnowledgeState(show)
    saveShowAdvancedKnowledge(show)
  }, [])

  return {
    showAdvancedKnowledge,
    setShowAdvancedKnowledge,
    isAdvancedKnowledgeModeReady,
  }
}
