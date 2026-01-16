// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Lightweight diff utility for content change highlighting
 * Uses a simple word-level diff algorithm optimized for text content
 */

export type DiffType = 'unchanged' | 'added' | 'removed'

export interface DiffSegment {
  type: DiffType
  text: string
}

/**
 * Tokenize text into words and whitespace
 * Preserves whitespace for accurate reconstruction
 */
function tokenize(text: string): string[] {
  // Split by word boundaries while preserving whitespace and punctuation
  return text.split(/(\s+|[，。、；：""''「」【】（）！？\n])/g).filter(Boolean)
}

/**
 * Compute Longest Common Subsequence (LCS) for two arrays
 * Returns the LCS table for backtracking
 */
function computeLCS(oldTokens: string[], newTokens: string[]): number[][] {
  const m = oldTokens.length
  const n = newTokens.length
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0))

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldTokens[i - 1] === newTokens[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  return dp
}

/**
 * Backtrack through LCS table to generate diff segments
 */
function backtrackDiff(
  oldTokens: string[],
  newTokens: string[],
  dp: number[][]
): DiffSegment[] {
  const segments: DiffSegment[] = []
  let i = oldTokens.length
  let j = newTokens.length

  // Temporary arrays to collect consecutive tokens of the same type
  const result: { type: DiffType; tokens: string[] }[] = []

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldTokens[i - 1] === newTokens[j - 1]) {
      // Unchanged
      result.unshift({ type: 'unchanged', tokens: [oldTokens[i - 1]] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      // Added in new
      result.unshift({ type: 'added', tokens: [newTokens[j - 1]] })
      j--
    } else if (i > 0) {
      // Removed from old
      result.unshift({ type: 'removed', tokens: [oldTokens[i - 1]] })
      i--
    }
  }

  // Merge consecutive segments of the same type
  for (const item of result) {
    const lastSegment = segments[segments.length - 1]
    if (lastSegment && lastSegment.type === item.type) {
      lastSegment.text += item.tokens[0]
    } else {
      segments.push({ type: item.type, text: item.tokens[0] })
    }
  }

  return segments
}

/**
 * Compute diff between old and new text
 * Returns an array of segments with type (unchanged, added, removed)
 */
export function computeDiff(oldText: string, newText: string): DiffSegment[] {
  // Handle edge cases
  if (oldText === newText) {
    return [{ type: 'unchanged', text: newText }]
  }

  if (!oldText) {
    return [{ type: 'added', text: newText }]
  }

  if (!newText) {
    return [{ type: 'removed', text: oldText }]
  }

  const oldTokens = tokenize(oldText)
  const newTokens = tokenize(newText)

  const dp = computeLCS(oldTokens, newTokens)
  return backtrackDiff(oldTokens, newTokens, dp)
}

/**
 * Simplified diff that only returns segments for the new content
 * (removed segments are not shown, only added and unchanged)
 * This is useful for showing what changed in the current version
 */
export function computeAddedDiff(oldText: string, newText: string): DiffSegment[] {
  const fullDiff = computeDiff(oldText, newText)
  // Filter out removed segments, keep only unchanged and added
  return fullDiff.filter(segment => segment.type !== 'removed')
}

/**
 * Check if there are any changes between old and new text
 */
export function hasChanges(oldText: string, newText: string): boolean {
  return oldText !== newText
}

/**
 * Get statistics about the diff
 */
export function getDiffStats(segments: DiffSegment[]): {
  addedCount: number
  removedCount: number
  unchangedCount: number
  hasChanges: boolean
} {
  let addedCount = 0
  let removedCount = 0
  let unchangedCount = 0

  for (const segment of segments) {
    const length = segment.text.length
    switch (segment.type) {
      case 'added':
        addedCount += length
        break
      case 'removed':
        removedCount += length
        break
      case 'unchanged':
        unchangedCount += length
        break
    }
  }

  return {
    addedCount,
    removedCount,
    unchangedCount,
    hasChanges: addedCount > 0 || removedCount > 0,
  }
}
