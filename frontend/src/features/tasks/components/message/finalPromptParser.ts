// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { FinalPromptData } from '@/types/api'

/**
 * Parse a Markdown final prompt section from an AI response.
 *
 * Supports flexible formats used by clarification and pipeline agents:
 * - ## ✅ 最终需求提示词
 * - ## Final Requirement Prompt
 * - ### 最终提示词
 * - # final prompt
 */
export function parseMarkdownFinalPrompt(content: string): FinalPromptData | null {
  const finalPromptHeaderRegex =
    /#{1,6}\s*(?:✅\s*)?(?:最终(?:需求)?提示词|final\s*(?:requirement\s*)?prompt)/im
  const headerMatch = content.match(finalPromptHeaderRegex)
  if (!headerMatch) {
    return null
  }

  const headerIndex = headerMatch.index ?? 0
  const contentFromHeader = content.substring(headerIndex)
  const headerLineEndIndex = contentFromHeader.indexOf('\n')
  if (headerLineEndIndex === -1) {
    return null
  }

  const afterHeader = contentFromHeader.substring(headerLineEndIndex + 1)
  const lastCodeBlockMarkerIndex = afterHeader.lastIndexOf('\n```')

  let promptContent: string
  if (lastCodeBlockMarkerIndex !== -1) {
    const contentAfterMarker = afterHeader.substring(lastCodeBlockMarkerIndex + 4)
    const linesAfterMarker = contentAfterMarker.split('\n').filter(line => line.trim() !== '')
    promptContent =
      linesAfterMarker.length <= 2
        ? afterHeader.substring(0, lastCodeBlockMarkerIndex).trim()
        : afterHeader.trim()
  } else {
    promptContent = afterHeader.trim()
  }

  if (!promptContent) {
    return null
  }

  return {
    type: 'final_prompt',
    final_prompt: promptContent,
  }
}
