// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * URL detection and classification utilities for smart URL rendering in chat messages.
 * Supports detecting image URLs, web page URLs, and Markdown-formatted links.
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
  '.tiff',
  '.tif',
]

// Regex pattern for detecting URLs in text
// Matches http:// or https:// URLs
// Excludes common Chinese punctuation marks to prevent them from being parsed as part of the URL
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]。，、；：？！""''（）【】《》]+/gi

// Regex pattern for Markdown image syntax: ![alt](url)
const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g

// Regex pattern for Markdown link syntax: [text](url)
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g

// Regex pattern for detecting code blocks (to exclude URLs inside them)
const CODE_BLOCK_REGEX = /```[\s\S]*?```|`[^`]+`/g

export interface DetectedUrl {
  /** The full URL */
  url: string
  /** Whether this is an image URL */
  isImage: boolean
  /** Start position in the original text */
  startIndex: number
  /** End position in the original text */
  endIndex: number
  /** Alt text (for Markdown images) */
  altText?: string
  /** Link text (for Markdown links) */
  linkText?: string
  /** Whether this URL is inside a Markdown syntax */
  isMarkdown: boolean
}

/**
 * Check if a URL points to an image based on its extension.
 * Checks both the pathname and query parameters for image extensions.
 * This handles cases where:
 * 1. The image extension is in the pathname (e.g., /path/to/image.png)
 * 2. The image extension is in a query parameter (e.g., /api/image?file=photo.jpg)
 */
export function isImageUrl(url: string): boolean {
  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname.toLowerCase()

    // Check if pathname ends with an image extension
    if (IMAGE_EXTENSIONS.some(ext => pathname.endsWith(ext))) {
      return true
    }

    // Check if any query parameter value contains an image extension
    // This handles URLs like /api/image_url?ikey=path/to/image.png
    for (const value of urlObj.searchParams.values()) {
      const decodedValue = decodeURIComponent(value).toLowerCase()
      if (IMAGE_EXTENSIONS.some(ext => decodedValue.endsWith(ext))) {
        return true
      }
    }

    return false
  } catch {
    // If URL parsing fails, try simple extension check on the full URL
    const lowerUrl = url.toLowerCase()
    return IMAGE_EXTENSIONS.some(ext => lowerUrl.endsWith(ext))
  }
}

/**
 * Get positions of code blocks in the text to exclude URLs inside them.
 */
function getCodeBlockRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let match

  // Reset regex state
  CODE_BLOCK_REGEX.lastIndex = 0

  while ((match = CODE_BLOCK_REGEX.exec(text)) !== null) {
    ranges.push({
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  return ranges
}

/**
 * Check if a position is inside any code block.
 */
function isInsideCodeBlock(
  position: number,
  codeBlockRanges: Array<{ start: number; end: number }>
): boolean {
  return codeBlockRanges.some(range => position >= range.start && position < range.end)
}

/**
 * Detect all URLs in a text string, including both plain URLs and Markdown-formatted URLs.
 * URLs inside code blocks are excluded.
 */
export function detectUrls(text: string): DetectedUrl[] {
  const urls: DetectedUrl[] = []
  const codeBlockRanges = getCodeBlockRanges(text)
  const processedRanges: Array<{ start: number; end: number }> = []

  // Check if a range overlaps with already processed ranges
  // Uses robust overlap check: two ranges [start, end) and [range.start, range.end) overlap
  // if and only if start < range.end && end > range.start
  const isOverlapping = (start: number, end: number): boolean => {
    return processedRanges.some(range => start < range.end && end > range.start)
  }

  // First, detect Markdown images: ![alt](url)
  let match
  MARKDOWN_IMAGE_REGEX.lastIndex = 0
  while ((match = MARKDOWN_IMAGE_REGEX.exec(text)) !== null) {
    if (
      isInsideCodeBlock(match.index, codeBlockRanges) ||
      isOverlapping(match.index, match.index + match[0].length)
    ) {
      continue
    }

    const url = match[2].trim()
    urls.push({
      url,
      isImage: true, // Markdown images are always treated as images
      startIndex: match.index,
      endIndex: match.index + match[0].length,
      altText: match[1],
      isMarkdown: true,
    })
    processedRanges.push({
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  // Then, detect Markdown links: [text](url)
  MARKDOWN_LINK_REGEX.lastIndex = 0
  while ((match = MARKDOWN_LINK_REGEX.exec(text)) !== null) {
    if (
      isInsideCodeBlock(match.index, codeBlockRanges) ||
      isOverlapping(match.index, match.index + match[0].length)
    ) {
      continue
    }

    const url = match[2].trim()
    const isImage = isImageUrl(url)

    urls.push({
      url,
      isImage,
      startIndex: match.index,
      endIndex: match.index + match[0].length,
      linkText: match[1],
      isMarkdown: true,
    })
    processedRanges.push({
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  // Finally, detect plain URLs (not inside Markdown syntax)
  URL_REGEX.lastIndex = 0
  while ((match = URL_REGEX.exec(text)) !== null) {
    if (
      isInsideCodeBlock(match.index, codeBlockRanges) ||
      isOverlapping(match.index, match.index + match[0].length)
    ) {
      continue
    }

    const url = match[0]
    // Clean up trailing punctuation, whitespace, and newlines that might have been captured
    // Includes both English and Chinese punctuation marks, spaces, tabs, and newlines
    const cleanUrl = url.replace(/[\s\n\r.,;:!?)。，、；：？！""''（）【】《》]+$/, '')

    urls.push({
      url: cleanUrl,
      isImage: isImageUrl(cleanUrl),
      startIndex: match.index,
      endIndex: match.index + cleanUrl.length,
      isMarkdown: false,
    })
    processedRanges.push({
      start: match.index,
      end: match.index + cleanUrl.length,
    })
  }

  // Sort by start index
  urls.sort((a, b) => a.startIndex - b.startIndex)

  return urls
}

/**
 * Check if text contains any URLs that could be rendered specially.
 */
export function hasRenderableUrls(text: string): boolean {
  const urls = detectUrls(text)
  return urls.length > 0
}

/**
 * Extract only image URLs from text.
 */
export function extractImageUrls(text: string): string[] {
  return detectUrls(text)
    .filter(u => u.isImage)
    .map(u => u.url)
}

/**
 * Extract only non-image (web page) URLs from text.
 */
export function extractWebPageUrls(text: string): string[] {
  return detectUrls(text)
    .filter(u => !u.isImage)
    .map(u => u.url)
}
