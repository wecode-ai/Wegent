// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * PDF Font Management Module
 * Handles Unicode font loading and management for PDF generation
 */

import type jsPDF from 'jspdf'
import type { FontStyle } from './types'
import { UNICODE_FONT_PATH, UNICODE_FONT_NAME } from './constants'

/**
 * Font loading state
 * fontDataCache stores the loaded font data for reuse across PDF instances
 */
let fontDataCache: ArrayBuffer | null = null
let fontLoadPromise: Promise<ArrayBuffer> | null = null

/**
 * Track which jsPDF instances have had the font added
 * Using WeakSet to allow garbage collection of PDF instances
 */
const pdfInstancesWithFont = new WeakSet<jsPDF>()

/**
 * Convert ArrayBuffer to Base64 string
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * Load Unicode font from local assets
 * Caches the font data for reuse across multiple PDF generations
 */
export async function loadUnicodeFont(): Promise<ArrayBuffer> {
  // Return cached font data if available
  if (fontDataCache) {
    return fontDataCache
  }

  // Return existing promise if font is being loaded
  if (fontLoadPromise) {
    return fontLoadPromise
  }

  fontLoadPromise = fetch(UNICODE_FONT_PATH)
    .then(response => {
      if (!response.ok) {
        throw new Error(`Failed to load font: ${response.status}`)
      }
      return response.arrayBuffer()
    })
    .then(data => {
      // Cache the font data for future use
      fontDataCache = data
      return data
    })
    .catch(error => {
      fontLoadPromise = null
      throw error
    })
  return fontLoadPromise
}

/**
 * Add Unicode font to jsPDF instance for extended character support
 * Each jsPDF instance needs to have the font added separately
 */
export async function addUnicodeFontToPdf(pdf: jsPDF): Promise<boolean> {
  // Check if this specific PDF instance already has the font
  if (pdfInstancesWithFont.has(pdf)) {
    return true
  }

  try {
    const fontData = await loadUnicodeFont()
    const fontBase64 = arrayBufferToBase64(fontData)

    // Add font to this jsPDF instance's virtual file system
    pdf.addFileToVFS(`${UNICODE_FONT_NAME}.ttf`, fontBase64)
    pdf.addFont(`${UNICODE_FONT_NAME}.ttf`, UNICODE_FONT_NAME, 'normal')

    // Mark this instance as having the font
    pdfInstancesWithFont.add(pdf)
    return true
  } catch (error) {
    console.warn('Failed to load Unicode font, falling back to default font:', error)
    return false
  }
}

/**
 * Check if text contains extended Unicode characters (CJK, Box Drawing, etc.)
 * that require special font support
 */
export function requiresUnicodeFont(text: string): boolean {
  // CJK Unified Ideographs and extensions, plus Box Drawing characters
  return /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u2500-\u257f\u2580-\u259f]/.test(
    text
  )
}

/**
 * Check if a jsPDF instance has Unicode font loaded
 */
export function hasUnicodeFontLoaded(pdf: jsPDF): boolean {
  return pdfInstancesWithFont.has(pdf)
}

/**
 * Set appropriate font based on text content
 * Uses Unicode font if text contains extended characters
 */
export function setFontForText(pdf: jsPDF, text: string, style: FontStyle = 'normal'): void {
  if (hasUnicodeFontLoaded(pdf) && requiresUnicodeFont(text)) {
    // Unicode font only supports normal style
    pdf.setFont(UNICODE_FONT_NAME, 'normal')
  } else {
    pdf.setFont('helvetica', style)
  }
}

/**
 * Check if a character is CJK (Chinese, Japanese, Korean)
 */
export function isCJKCharacter(char: string): boolean {
  const code = char.charCodeAt(0)
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Unified Ideographs Extension A
    (code >= 0x3000 && code <= 0x303f) || // CJK Symbols and Punctuation
    (code >= 0xff00 && code <= 0xffef) || // Halfwidth and Fullwidth Forms
    (code >= 0x3040 && code <= 0x309f) || // Hiragana
    (code >= 0x30a0 && code <= 0x30ff) || // Katakana
    (code >= 0xac00 && code <= 0xd7af) // Hangul Syllables
  )
}

/**
 * Split text into wrappable units (words for Latin, characters for CJK)
 */
export function splitTextIntoWrappableUnits(text: string): string[] {
  const units: string[] = []
  let currentUnit = ''

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    // Check if character is CJK (can break at any character)
    if (isCJKCharacter(char)) {
      // Push any accumulated Latin text first
      if (currentUnit.length > 0) {
        units.push(currentUnit)
        currentUnit = ''
      }
      // CJK characters are individual units
      units.push(char)
    } else if (char === ' ') {
      // Space is a word boundary for Latin text
      if (currentUnit.length > 0) {
        units.push(currentUnit + ' ')
        currentUnit = ''
      } else {
        units.push(' ')
      }
    } else {
      // Accumulate Latin characters
      currentUnit += char
    }
  }

  // Push any remaining text
  if (currentUnit.length > 0) {
    units.push(currentUnit)
  }

  return units
}
