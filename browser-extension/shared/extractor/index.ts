// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Web page content extractor using Readability.js
 */

import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'

export interface PageMetadata {
  title: string
  url: string
  description?: string
  keywords?: string
  siteName?: string
  author?: string
  publishedTime?: string
}

export interface ExtractedContent {
  text: string
  markdown: string
  metadata: PageMetadata
  extractedAt: string
}

/**
 * Extract metadata from the current page
 */
export function extractMetadata(doc: Document): PageMetadata {
  const getMetaContent = (name: string): string | undefined => {
    const meta =
      doc.querySelector(`meta[name="${name}"]`) ||
      doc.querySelector(`meta[property="${name}"]`) ||
      doc.querySelector(`meta[property="og:${name}"]`)
    return meta?.getAttribute('content') || undefined
  }

  return {
    title: doc.title || getMetaContent('title') || 'Untitled',
    url: doc.location?.href || '',
    description: getMetaContent('description'),
    keywords: getMetaContent('keywords'),
    siteName: getMetaContent('site_name'),
    author: getMetaContent('author'),
    publishedTime: getMetaContent('published_time') || getMetaContent('article:published_time'),
  }
}

/**
 * Extract main content from a web page using Readability
 */
export function extractPageContent(doc: Document): ExtractedContent {
  const metadata = extractMetadata(doc)
  const extractedAt = new Date().toISOString()

  // Clone the document to avoid modifying the original
  const documentClone = doc.cloneNode(true) as Document

  // Use Readability to extract the main content
  const reader = new Readability(documentClone)
  const article = reader.parse()

  if (!article) {
    // Fallback: extract all text content
    const bodyText = doc.body?.innerText || ''
    return {
      text: formatWithMetadata(bodyText, metadata, extractedAt),
      markdown: formatWithMetadata(bodyText, metadata, extractedAt),
      metadata,
      extractedAt,
    }
  }

  // Convert HTML to Markdown
  const turndownService = createTurndownService()
  const markdown = turndownService.turndown(article.content)

  // Get plain text
  const tempDiv = doc.createElement('div')
  tempDiv.innerHTML = article.content
  const plainText = tempDiv.textContent || tempDiv.innerText || ''

  return {
    text: formatWithMetadata(plainText, metadata, extractedAt),
    markdown: formatWithMetadata(markdown, metadata, extractedAt),
    metadata,
    extractedAt,
  }
}

/**
 * Extract selected text with metadata
 */
export function extractSelectedText(
  selection: string,
  doc: Document,
): ExtractedContent {
  const metadata = extractMetadata(doc)
  const extractedAt = new Date().toISOString()

  const formattedText = formatWithMetadata(selection, metadata, extractedAt)

  return {
    text: formattedText,
    markdown: formattedText,
    metadata,
    extractedAt,
  }
}

/**
 * Format content with metadata header
 */
function formatWithMetadata(
  content: string,
  metadata: PageMetadata,
  extractedAt: string,
): string {
  const lines = [
    '---',
    `Title: ${metadata.title}`,
    `URL: ${metadata.url}`,
  ]

  if (metadata.description) {
    lines.push(`Description: ${metadata.description}`)
  }

  if (metadata.author) {
    lines.push(`Author: ${metadata.author}`)
  }

  if (metadata.publishedTime) {
    lines.push(`Published: ${metadata.publishedTime}`)
  }

  lines.push(`Extracted: ${extractedAt}`)
  lines.push('---')
  lines.push('')
  lines.push(content.trim())

  return lines.join('\n')
}

/**
 * Create a configured Turndown service for HTML to Markdown conversion
 */
function createTurndownService(): TurndownService {
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  })

  // Add custom rules
  turndownService.addRule('removeScripts', {
    filter: ['script', 'style', 'noscript'],
    replacement: () => '',
  })

  turndownService.addRule('preserveImages', {
    filter: 'img',
    replacement: (_content, node) => {
      const img = node as HTMLImageElement
      const alt = img.alt || 'image'
      const src = img.src
      return src ? `![${alt}](${src})` : ''
    },
  })

  return turndownService
}

/**
 * Get a preview of the content (first N characters)
 */
export function getContentPreview(content: string, maxLength: number = 500): string {
  if (content.length <= maxLength) {
    return content
  }
  return content.substring(0, maxLength) + '...'
}
