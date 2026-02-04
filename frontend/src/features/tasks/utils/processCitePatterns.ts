// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Utility to process [cite: X, Y, Z] patterns in text content
 * and convert them to clickable markdown links.
 *
 * Example:
 *   Input: "Some text [cite: 13, 14]."
 *   Output: "Some text [[13]](url_13)[[14]](url_14)."
 */

import type { GeminiAnnotation } from '@/types/socket'

/**
 * Build a map from annotation index to source URL.
 * Annotations are 1-indexed in the text (e.g., [cite: 1] refers to first annotation).
 */
function buildAnnotationUrlMap(annotations: GeminiAnnotation[]): Map<number, string> {
  const urlMap = new Map<number, string>()

  // Sort annotations by start_index to maintain order
  const sortedAnnotations = [...annotations].sort((a, b) => a.start_index - b.start_index)

  // Build 1-indexed map (citation numbers in text are 1-based)
  sortedAnnotations.forEach((annotation, index) => {
    urlMap.set(index + 1, annotation.source)
  })

  return urlMap
}

/**
 * Process content to convert [cite: X, Y, Z] patterns to markdown links.
 *
 * @param content - The text content containing cite patterns
 * @param annotations - Array of Gemini annotations with source URLs
 * @returns Content with cite patterns converted to clickable markdown links
 */
export function processCitePatterns(
  content: string,
  annotations: GeminiAnnotation[] | undefined
): string {
  if (!content || !annotations || annotations.length === 0) {
    return content
  }

  const urlMap = buildAnnotationUrlMap(annotations)

  // Pattern matches [cite: X] or [cite: X, Y] or [cite: X, Y, Z] etc.
  // Captures the numbers inside
  const citePattern = /\[cite:\s*([\d,\s]+)\]/g

  return content.replace(citePattern, (match, numbersStr: string) => {
    // Parse the numbers from the capture group
    const numbers = numbersStr
      .split(',')
      .map(n => parseInt(n.trim(), 10))
      .filter(n => !isNaN(n))

    if (numbers.length === 0) {
      return match // Return original if no valid numbers
    }

    // Convert each number to a markdown link
    const links = numbers.map(num => {
      const url = urlMap.get(num)
      if (url) {
        // Format: [13](url) - clickable number
        return `[${num}](${url})`
      }
      // No URL found, just return the number in brackets
      return `[${num}]`
    })

    // Join with no separator - each link is self-contained
    return links.join('')
  })
}
