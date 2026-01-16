// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * PDF Utility Functions Module
 * Contains helper functions for PDF generation
 */

import { IMAGE_EXTENSIONS, FILE_TYPE_LABELS } from './constants'

/**
 * Sanitize filename by removing or replacing invalid characters
 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .trim()
}

/**
 * Format date for filename
 */
export function formatDateForFilename(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/**
 * Format timestamp for display
 */
export function formatTimestamp(timestamp: number): string {
  if (typeof timestamp !== 'number' || Number.isNaN(timestamp)) return ''
  return new Date(timestamp).toLocaleString(navigator.language, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

/**
 * Get file type label based on file extension
 * Uses simple text labels instead of emoji for PDF compatibility
 */
export function getFileTypeLabel(extension: string): string {
  const ext = extension.toLowerCase().replace('.', '')
  return FILE_TYPE_LABELS[ext] || '[FILE]'
}

/**
 * Check if a file extension is an image type
 */
export function isImageExtension(extension: string): boolean {
  const ext = extension.toLowerCase()
  return IMAGE_EXTENSIONS.includes(ext)
}

/**
 * Get image format for jsPDF from file extension
 */
export function getImageFormat(extension: string): string {
  const ext = extension.toLowerCase().replace('.', '')
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'JPEG'
    case 'png':
      return 'PNG'
    case 'gif':
      return 'GIF'
    case 'webp':
      return 'WEBP'
    default:
      return 'JPEG'
  }
}

/**
 * Check if a line is a code block delimiter
 */
export function isCodeBlockDelimiter(line: string): boolean {
  return line.trim().startsWith('```')
}

/**
 * Extract language from code block delimiter
 export function extractCodeLanguage(line: string): string {
   const trimmedLine = line.trim();
   const match = trimmedLine.match(/^```(\w*)/);
   const language = match?.[1] || '';
   
   return language;
 }
}

/**
 * Sanitize content for PDF rendering
 * Removes special markers and normalizes line breaks
 */
export function sanitizeContent(content: string): string {
  let result = content
  // Replace special line break markers
  result = result.replace(/\$\{\$\$\}\$/g, '\n')
  // Remove progress bar markers
  result = result.replace(/__PROGRESS_BAR__:.*?:\d+/g, '')
  // Clean up prompt truncated markers
  result = result.replace(/__PROMPT_TRUNCATED__:.*?::(.*?)(?=\n|$)/g, '$1')
  return result
}
