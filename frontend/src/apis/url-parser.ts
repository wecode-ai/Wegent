// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * URL Parser API client.
 *
 * Provides functionality to parse URLs and extract content
 * for use in Chat Shell conversations.
 */

import { getToken } from './user'

// API base URL - uses Next.js API Route proxy
const API_BASE_URL = '/api'

/**
 * URL content type
 */
export type UrlType = 'webpage' | 'image' | 'pdf' | 'unknown'

/**
 * Parsed URL result
 */
export interface ParsedUrlResult {
  /** Original URL */
  url: string
  /** Type of content */
  type: UrlType
  /** Page title (for webpages and PDFs) */
  title?: string | null
  /** Parsed content (markdown for webpages, base64 for images, text for PDFs) */
  content?: string | null
  /** Whether content was truncated */
  truncated: boolean
  /** Error message if parsing failed */
  error?: string | null
  /** Content size in bytes */
  size?: number | null
}

/**
 * Request body for parsing URLs
 */
export interface ParseUrlsRequest {
  urls: string[]
}

/**
 * Response body for parsed URLs
 */
export interface ParseUrlsResponse {
  results: ParsedUrlResult[]
}

/**
 * Parse URLs and extract their content.
 *
 * @param urls - List of URLs to parse
 * @returns Parsed content for each URL
 */
export async function parseUrls(urls: string[]): Promise<ParseUrlsResponse> {
  const token = getToken()

  const response = await fetch(`${API_BASE_URL}/chat/parse-urls`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ urls }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    let errorMsg = errorText
    try {
      const json = JSON.parse(errorText)
      if (json && typeof json.detail === 'string') {
        errorMsg = json.detail
      }
    } catch {
      // Not JSON
    }
    throw new Error(errorMsg)
  }

  return response.json()
}

/**
 * URL detection regex pattern
 * Matches HTTP and HTTPS URLs
 */
export const URL_REGEX =
  /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_+.~#?&/=]*)/gi

/**
 * Detect URLs in text content.
 *
 * @param text - Text to search for URLs
 * @returns Array of detected URLs
 */
export function detectUrls(text: string): string[] {
  const matches = text.match(URL_REGEX)
  if (!matches) return []

  // Remove duplicates
  return [...new Set(matches)]
}

/**
 * Check if a URL is an image URL based on extension.
 *
 * @param url - URL to check
 * @returns True if URL points to an image
 */
export function isImageUrl(url: string): boolean {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']
  const lowerUrl = url.toLowerCase()
  return imageExtensions.some(ext => lowerUrl.includes(ext))
}

/**
 * Check if a URL is a PDF URL based on extension.
 *
 * @param url - URL to check
 * @returns True if URL points to a PDF
 */
export function isPdfUrl(url: string): boolean {
  return url.toLowerCase().includes('.pdf')
}

/**
 * Get display domain from URL.
 *
 * @param url - URL to extract domain from
 * @returns Domain name or empty string
 */
export function getUrlDomain(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.hostname.replace('www.', '')
  } catch {
    return ''
  }
}

/**
 * Format file size for display.
 *
 * @param bytes - Size in bytes
 * @returns Formatted size string
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * URL Parser API exports
 */
export const urlParserApis = {
  parseUrls,
  detectUrls,
  isImageUrl,
  isPdfUrl,
  getUrlDomain,
  formatFileSize,
}
