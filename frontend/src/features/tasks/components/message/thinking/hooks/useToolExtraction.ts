// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useToolExtraction Hook
 *
 * Hook for extracting and grouping tools from thinking steps.
 */

import { useMemo } from 'react'
import type { ThinkingStep, ToolGroup } from '../types'
import { extractToolPairs, groupConsecutiveTools, filterNonToolSteps } from '../utils/toolExtractor'

interface UseToolExtractionResult {
  toolGroups: ToolGroup[]
  nonToolSteps: ThinkingStep[]
  hasTools: boolean
}

export function useToolExtraction(thinking: ThinkingStep[] | null): UseToolExtractionResult {
  return useMemo(() => {
    if (!thinking || thinking.length === 0) {
      return {
        toolGroups: [],
        nonToolSteps: [],
        hasTools: false,
      }
    }

    const pairs = extractToolPairs(thinking)
    const toolGroups = groupConsecutiveTools(pairs)
    const nonToolSteps = filterNonToolSteps(thinking)

    return {
      toolGroups,
      nonToolSteps,
      hasTools: toolGroups.length > 0 && toolGroups.some(g => g.tools.length > 0),
    }
  }, [thinking])
}
