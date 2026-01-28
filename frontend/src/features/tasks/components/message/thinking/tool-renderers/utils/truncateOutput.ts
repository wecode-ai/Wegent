// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { MAX_OUTPUT_LENGTH, MAX_OUTPUT_LINES } from '../constants'

interface TruncateResult {
  data: string | null
  isTruncated: boolean
  originalLength: number
  originalLineCount: number
}

/**
 * Truncate output if it exceeds the maximum length
 */
export function truncateOutput(output: string | null | undefined): TruncateResult {
  if (!output) {
    return {
      data: null,
      isTruncated: false,
      originalLength: 0,
      originalLineCount: 0,
    }
  }

  const originalLength = output.length
  const originalLineCount = output.split('\n').length

  // Check if truncation is needed based on character length or line count
  const needsTruncationByLength = originalLength > MAX_OUTPUT_LENGTH
  const needsTruncationByLines = originalLineCount > MAX_OUTPUT_LINES

  if (!needsTruncationByLength && !needsTruncationByLines) {
    return {
      data: output,
      isTruncated: false,
      originalLength,
      originalLineCount,
    }
  }

  // Truncate by lines first if that's the limiting factor
  if (needsTruncationByLines && !needsTruncationByLength) {
    const lines = output.split('\n')
    const truncatedLines = lines.slice(0, MAX_OUTPUT_LINES)
    return {
      data: truncatedLines.join('\n'),
      isTruncated: true,
      originalLength,
      originalLineCount,
    }
  }

  // Truncate by character length
  return {
    data: output.slice(0, MAX_OUTPUT_LENGTH),
    isTruncated: true,
    originalLength,
    originalLineCount,
  }
}
