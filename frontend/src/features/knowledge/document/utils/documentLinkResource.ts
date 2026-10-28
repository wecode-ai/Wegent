// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type DocumentLinkPreviewKind = 'pdf' | 'office' | 'video' | 'image' | 'text' | 'unknown'

export interface DocumentLinkResource {
  key: string
  documentId: number
  url: string
  label: string
  filename: string
  kindHint: DocumentLinkPreviewKind
  expiresAt?: number
}

const FILE_EXTENSIONS = new Set([
  'pdf',
  'mp4',
  'docx',
  'xlsx',
  'pptx',
  'md',
  'markdown',
  'txt',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
])

function safeUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function decodedPath(value: string): string {
  const path = safeUrl(value)?.pathname || value.split(/[?#]/, 1)[0]
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

function fileExtension(value: string): string {
  return decodedPath(value).split('/').pop()?.split('.').pop()?.toLowerCase() || ''
}

function queryValue(url: URL, name: string): string | null {
  const expected = name.toLowerCase()
  for (const [key, value] of url.searchParams.entries()) {
    if (key.toLowerCase() === expected) return value
  }
  return null
}

function parseSignedDate(value: string | null): number | undefined {
  const match = value?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
  if (!match) return undefined
  const [, year, month, day, hour, minute, second] = match
  const timestamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  )
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function signedUrlExpiry(url: URL): number | undefined {
  const absoluteExpiry = queryValue(url, 'Expires')
  if (absoluteExpiry && /^\d+$/.test(absoluteExpiry)) {
    const timestamp = Number(absoluteExpiry) * 1000
    return Number.isFinite(timestamp) ? timestamp : undefined
  }

  const signedAt = parseSignedDate(queryValue(url, 'x-oss-date') || queryValue(url, 'x-amz-date'))
  const lifetime = queryValue(url, 'x-oss-expires') || queryValue(url, 'x-amz-expires')
  if (!signedAt || !lifetime || !/^\d+$/.test(lifetime)) return undefined
  const timestamp = signedAt + Number(lifetime) * 1000
  return Number.isFinite(timestamp) ? timestamp : undefined
}

export function getDocumentLinkKind(value: string): DocumentLinkPreviewKind {
  const extension = fileExtension(value)
  if (extension === 'pdf') return 'pdf'
  if (['docx', 'xlsx', 'pptx'].includes(extension)) return 'office'
  if (extension === 'mp4') return 'video'
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(extension)) return 'image'
  if (['md', 'markdown', 'txt'].includes(extension)) return 'text'
  return 'unknown'
}

export function isDocumentFileLink(value: string): boolean {
  return FILE_EXTENSIONS.has(fileExtension(value))
}

export function createDocumentLinkResource(
  documentId: number,
  href: string,
  label?: string
): DocumentLinkResource | null {
  const url = safeUrl(href)
  if (!url || url.protocol !== 'https:' || url.username || url.password) return null
  const filename = decodedPath(href).split('/').pop() || label || 'file'
  const expiresAt = signedUrlExpiry(url)
  return {
    key: `${documentId}:${href}`,
    documentId,
    url: href,
    label: label?.trim() || filename,
    filename,
    kindHint: getDocumentLinkKind(href),
    expiresAt,
  }
}
