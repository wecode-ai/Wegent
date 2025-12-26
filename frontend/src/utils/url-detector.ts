// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * URL detection and classification utilities for smart URL rendering
 */

// Common image file extensions
const IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico',
  '.avif',
  '.apng',
]

// URL regex pattern that matches HTTP/HTTPS URLs
// Matches URLs starting with http:// or https:// followed by valid URL characters
const URL_REGEX =
  /https?:\/\/[^\s<>"{}|\\^`[\]]+(?:\([^\s<>"{}|\\^`[\]]*\)|[^\s<>"{}|\\^`[\]().,;:!?'")\]])/gi

// Markdown image syntax: ![alt](url)
const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g

// Markdown link syntax: [text](url)
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g

/**
 * Represents a detected URL with its metadata
 */
export interface DetectedUrl {
  /** The original URL string */
  url: string
  /** Whether this URL points to an image */
  isImage: boolean
  /** The start position in the original text */
  startIndex: number
  /** The end position in the original text */
  endIndex: number
  /** If this is a markdown link/image, the display text/alt text */
  displayText?: string
  /** The type of URL detection (plain, markdown-image, markdown-link) */
  type: 'plain' | 'markdown-image' | 'markdown-link'
}

/**
 * Check if a URL points to an image based on file extension
 * @param url The URL to check
 * @returns True if the URL appears to be an image
 */
export function isImageUrl(url: string): boolean {
  try {
    // Parse the URL to get the pathname
    const urlObj = new URL(url)
    const pathname = urlObj.pathname.toLowerCase()

    // Check if the pathname ends with a known image extension
    return IMAGE_EXTENSIONS.some((ext) => pathname.endsWith(ext))
  } catch {
    // If URL parsing fails, try a simple string check
    const lowerUrl = url.toLowerCase()
    return IMAGE_EXTENSIONS.some((ext) => lowerUrl.includes(ext))
  }
}

/**
 * Check if text is inside a code block
 * @param text The full text content
 * @param position The position to check
 * @returns True if the position is inside a code block
 */
export function isInsideCodeBlock(text: string, position: number): boolean {
  // Count backticks before the position
  const textBefore = text.substring(0, position)

  // Check for fenced code blocks (```)
  const fencedCodeBlocks = textBefore.match(/```/g)
  if (fencedCodeBlocks && fencedCodeBlocks.length % 2 === 1) {
    return true
  }

  // Check for inline code (single backtick)
  // Find the last newline before position
  const lastNewline = textBefore.lastIndexOf('\n')
  const currentLine = textBefore.substring(lastNewline + 1)

  // Count backticks in current line
  const backticks = currentLine.match(/`/g)
  if (backticks && backticks.length % 2 === 1) {
    return true
  }

  return false
}

/**
 * Detect all URLs in a text string
 * @param text The text to scan for URLs
 * @returns Array of detected URLs with metadata
 */
export function detectUrls(text: string): DetectedUrl[] {
  const results: DetectedUrl[] = []
  const processedRanges: Array<{ start: number; end: number }> = []

  // Helper to check if a range overlaps with already processed ranges
  const isOverlapping = (start: number, end: number): boolean => {
    return processedRanges.some(
      (range) =>
        (start >= range.start && start < range.end) || (end > range.start && end <= range.end)
    )
  }

  // First, detect markdown images ![alt](url)
  let match: RegExpExecArray | null
  const imageRegex = new RegExp(MARKDOWN_IMAGE_REGEX.source, 'g')
  while ((match = imageRegex.exec(text)) !== null) {
    const startIndex = match.index
    const endIndex = startIndex + match[0].length

    // Skip if inside code block
    if (isInsideCodeBlock(text, startIndex)) {
      continue
    }

    const altText = match[1]
    const url = match[2]

    results.push({
      url,
      isImage: true, // Markdown image syntax always indicates an image
      startIndex,
      endIndex,
      displayText: altText,
      type: 'markdown-image',
    })

    processedRanges.push({ start: startIndex, end: endIndex })
  }

  // Then, detect markdown links [text](url)
  const linkRegex = new RegExp(MARKDOWN_LINK_REGEX.source, 'g')
  while ((match = linkRegex.exec(text)) !== null) {
    const startIndex = match.index
    const endIndex = startIndex + match[0].length

    // Skip if already processed (as markdown image) or inside code block
    if (isOverlapping(startIndex, endIndex) || isInsideCodeBlock(text, startIndex)) {
      continue
    }

    const linkText = match[1]
    const url = match[2]

    results.push({
      url,
      isImage: isImageUrl(url),
      startIndex,
      endIndex,
      displayText: linkText,
      type: 'markdown-link',
    })

    processedRanges.push({ start: startIndex, end: endIndex })
  }

  // Finally, detect plain URLs
  const plainUrlRegex = new RegExp(URL_REGEX.source, 'gi')
  while ((match = plainUrlRegex.exec(text)) !== null) {
    const startIndex = match.index
    const endIndex = startIndex + match[0].length

    // Skip if already processed (as markdown link/image) or inside code block
    if (isOverlapping(startIndex, endIndex) || isInsideCodeBlock(text, startIndex)) {
      continue
    }

    const url = match[0]

    results.push({
      url,
      isImage: isImageUrl(url),
      startIndex,
      endIndex,
      type: 'plain',
    })

    processedRanges.push({ start: startIndex, end: endIndex })
  }

  // Sort by start index
  results.sort((a, b) => a.startIndex - b.startIndex)

  return results
}

/**
 * Extract the domain from a URL
 * @param url The URL to extract domain from
 * @returns The domain name (e.g., "example.com")
 */
export function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url)
    return urlObj.hostname
  } catch {
    // If parsing fails, try to extract domain manually
    const domainMatch = url.match(/https?:\/\/([^/]+)/)
    return domainMatch ? domainMatch[1] : url
  }
}

/**
 * Validate if a string is a valid URL
 * @param url The string to validate
 * @returns True if it's a valid URL
 */
export function isValidUrl(url: string): boolean {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

/**
 * Get a display-friendly version of a URL
 * @param url The URL to format
 * @param maxLength Maximum length before truncation
 * @returns Formatted URL string
 */
export function formatDisplayUrl(url: string, maxLength: number = 50): string {
  try {
    const urlObj = new URL(url)
    let display = urlObj.hostname + urlObj.pathname

    // Remove trailing slash
    if (display.endsWith('/')) {
      display = display.slice(0, -1)
    }

    // Truncate if too long
    if (display.length > maxLength) {
      return display.substring(0, maxLength - 3) + '...'
    }

    return display
  } catch {
    // If parsing fails, just truncate the original URL
    if (url.length > maxLength) {
      return url.substring(0, maxLength - 3) + '...'
    }
    return url
  }
}
