// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * URL detection and classification utilities for smart URL rendering in chat messages
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
  '.tiff',
  '.tif',
];

// URL regex pattern that matches HTTP/HTTPS URLs
// This pattern captures URLs that are:
// 1. Standalone URLs in text
// 2. URLs in markdown link syntax [text](url)
// 3. URLs in markdown image syntax ![alt](url)
const URL_REGEX =
  /https?:\/\/(?:[-\w.]|(?:%[\da-fA-F]{2}))+(?::\d+)?(?:\/(?:[-\w._~:/?#[\]@!$&'()*+,;=%])*)?/gi;

// Markdown image syntax: ![alt](url)
const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g;

// Markdown link syntax: [text](url)
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g;

// Code block detection regex (to avoid processing URLs inside code blocks)
const CODE_BLOCK_REGEX = /```[\s\S]*?```|`[^`]+`/g;

export interface DetectedUrl {
  /** The full URL string */
  url: string;
  /** Whether this URL points to an image */
  isImage: boolean;
  /** Original text (for markdown links, this is the link text) */
  text?: string;
  /** Alt text for images (from markdown syntax) */
  alt?: string;
  /** Start index in the original string */
  startIndex: number;
  /** End index in the original string */
  endIndex: number;
  /** Whether this URL was found in markdown syntax */
  isMarkdown: boolean;
  /** Type of markdown syntax if applicable */
  markdownType?: 'image' | 'link';
}

/**
 * Check if a URL points to an image based on file extension
 * @param url - The URL to check
 * @returns true if the URL appears to be an image
 */
export function isImageUrl(url: string): boolean {
  try {
    // Parse URL to get pathname
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();

    // Check for common image extensions
    return IMAGE_EXTENSIONS.some(ext => pathname.endsWith(ext));
  } catch {
    // If URL parsing fails, try simple extension check
    const lowerUrl = url.toLowerCase();
    return IMAGE_EXTENSIONS.some(ext => lowerUrl.includes(ext));
  }
}

/**
 * Get positions of code blocks in the text to avoid processing URLs within them
 * @param text - The text to scan
 * @returns Array of [start, end] positions of code blocks
 */
function getCodeBlockPositions(text: string): Array<[number, number]> {
  const positions: Array<[number, number]> = [];
  let match;

  CODE_BLOCK_REGEX.lastIndex = 0;
  while ((match = CODE_BLOCK_REGEX.exec(text)) !== null) {
    positions.push([match.index, match.index + match[0].length]);
  }

  return positions;
}

/**
 * Check if a position is inside any code block
 * @param position - The position to check
 * @param codeBlocks - Array of code block positions
 * @returns true if position is inside a code block
 */
function isInsideCodeBlock(position: number, codeBlocks: Array<[number, number]>): boolean {
  return codeBlocks.some(([start, end]) => position >= start && position < end);
}

/**
 * Detect all URLs in a text string, classifying them as images or web pages
 * Handles:
 * - Plain URLs in text
 * - Markdown image syntax ![alt](url)
 * - Markdown link syntax [text](url)
 * - Skips URLs inside code blocks
 *
 * @param text - The text content to scan for URLs
 * @returns Array of detected URLs with metadata
 */
export function detectUrls(text: string): DetectedUrl[] {
  const detected: DetectedUrl[] = [];
  const processedRanges: Array<[number, number]> = [];
  const codeBlocks = getCodeBlockPositions(text);

  // Helper to check if a range overlaps with already processed ranges
  const isOverlapping = (start: number, end: number): boolean => {
    return processedRanges.some(
      ([s, e]) => (start >= s && start < e) || (end > s && end <= e) || (start <= s && end >= e)
    );
  };

  // First, process markdown images
  MARKDOWN_IMAGE_REGEX.lastIndex = 0;
  let match;
  while ((match = MARKDOWN_IMAGE_REGEX.exec(text)) !== null) {
    const startIndex = match.index;
    const endIndex = match.index + match[0].length;

    // Skip if inside code block
    if (isInsideCodeBlock(startIndex, codeBlocks)) {
      continue;
    }

    const alt = match[1];
    const url = match[2];

    detected.push({
      url,
      isImage: true, // Markdown images are always treated as images
      alt,
      startIndex,
      endIndex,
      isMarkdown: true,
      markdownType: 'image',
    });

    processedRanges.push([startIndex, endIndex]);
  }

  // Then, process markdown links (excluding already processed image syntax)
  MARKDOWN_LINK_REGEX.lastIndex = 0;
  while ((match = MARKDOWN_LINK_REGEX.exec(text)) !== null) {
    const startIndex = match.index;
    const endIndex = match.index + match[0].length;

    // Skip if inside code block or already processed (markdown image)
    if (isInsideCodeBlock(startIndex, codeBlocks) || isOverlapping(startIndex, endIndex)) {
      continue;
    }

    const linkText = match[1];
    const url = match[2];

    // Validate URL
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      continue;
    }

    detected.push({
      url,
      isImage: isImageUrl(url),
      text: linkText,
      startIndex,
      endIndex,
      isMarkdown: true,
      markdownType: 'link',
    });

    processedRanges.push([startIndex, endIndex]);
  }

  // Finally, process plain URLs (not already in markdown syntax)
  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    const startIndex = match.index;
    const endIndex = match.index + match[0].length;

    // Skip if inside code block or already processed
    if (isInsideCodeBlock(startIndex, codeBlocks) || isOverlapping(startIndex, endIndex)) {
      continue;
    }

    const url = match[0];

    detected.push({
      url,
      isImage: isImageUrl(url),
      startIndex,
      endIndex,
      isMarkdown: false,
    });

    processedRanges.push([startIndex, endIndex]);
  }

  // Sort by start index
  detected.sort((a, b) => a.startIndex - b.startIndex);

  return detected;
}

/**
 * Extract unique non-image URLs from text for metadata fetching
 * This is useful for batch fetching metadata for all web links in a message
 *
 * @param text - The text content to scan
 * @returns Array of unique web page URLs (non-images)
 */
export function extractWebUrls(text: string): string[] {
  const detected = detectUrls(text);
  const webUrls = detected.filter(d => !d.isImage).map(d => d.url);

  // Return unique URLs
  return [...new Set(webUrls)];
}

/**
 * Extract unique image URLs from text
 *
 * @param text - The text content to scan
 * @returns Array of unique image URLs
 */
export function extractImageUrls(text: string): string[] {
  const detected = detectUrls(text);
  const imageUrls = detected.filter(d => d.isImage).map(d => d.url);

  // Return unique URLs
  return [...new Set(imageUrls)];
}

/**
 * Check if text contains any URLs that should be rendered specially
 *
 * @param text - The text content to check
 * @returns true if text contains renderable URLs
 */
export function hasRenderableUrls(text: string): boolean {
  const detected = detectUrls(text);
  return detected.length > 0;
}
