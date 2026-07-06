// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { type RemoteWorkspaceTreeEntry } from '@/apis/remoteWorkspace'

export type PreviewKind = 'none' | 'text' | 'image' | 'pdf' | 'excel' | 'unsupported'
export type SortOption = 'name_asc' | 'name_desc' | 'size_desc' | 'modified_desc'

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'json',
  'yml',
  'yaml',
  'xml',
  'js',
  'jsx',
  'ts',
  'tsx',
  'py',
  'java',
  'go',
  'rs',
  'c',
  'cc',
  'cpp',
  'h',
  'hpp',
  'sh',
  'sql',
  'css',
  'scss',
  'html',
])

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])

const EXCEL_EXTENSIONS = new Set(['xlsx', 'xls', 'csv'])

function getFileExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.')
  if (lastDot < 0) {
    return ''
  }

  return fileName.slice(lastDot + 1).toLowerCase()
}

export function isMarkdownFile(fileName: string): boolean {
  return getFileExtension(fileName) === 'md'
}

export function isJsonFile(fileName: string): boolean {
  return getFileExtension(fileName) === 'json'
}

export function shouldUseFormattedTextPreview(fileName: string): boolean {
  return isMarkdownFile(fileName) || isJsonFile(fileName)
}

export function resolvePreviewKind(fileName: string): PreviewKind {
  const extension = getFileExtension(fileName)

  if (!extension) {
    return 'unsupported'
  }
  if (extension === 'pdf') {
    return 'pdf'
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return 'image'
  }
  if (EXCEL_EXTENSIONS.has(extension)) {
    return 'excel'
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return 'text'
  }

  return 'unsupported'
}

export function getMimeTypeFromPreviewKind(previewKind: PreviewKind, filename: string): string {
  switch (previewKind) {
    case 'image':
      return 'image/png'
    case 'pdf':
      return 'application/pdf'
    case 'excel':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case 'text':
      if (filename.endsWith('.py')) return 'text/x-python'
      if (filename.endsWith('.js')) return 'application/javascript'
      if (filename.endsWith('.ts')) return 'application/typescript'
      if (filename.endsWith('.json')) return 'application/json'
      if (filename.endsWith('.md')) return 'text/markdown'
      if (filename.endsWith('.html') || filename.endsWith('.htm')) return 'text/html'
      if (filename.endsWith('.css')) return 'text/css'
      if (filename.endsWith('.xml')) return 'application/xml'
      if (filename.endsWith('.yaml') || filename.endsWith('.yml')) return 'application/yaml'
      return 'text/plain'
    default:
      return 'application/octet-stream'
  }
}

function parseModifiedAt(modifiedAt?: string | null): number {
  if (!modifiedAt) {
    return 0
  }
  const parsed = Date.parse(modifiedAt)
  return Number.isNaN(parsed) ? 0 : parsed
}

export function sortTreeEntries(
  entries: RemoteWorkspaceTreeEntry[],
  option: SortOption
): RemoteWorkspaceTreeEntry[] {
  return [...entries].sort((left, right) => {
    if (left.is_directory !== right.is_directory) {
      return left.is_directory ? -1 : 1
    }

    if (option === 'name_desc') {
      return right.name.localeCompare(left.name)
    }
    if (option === 'size_desc') {
      return right.size - left.size || left.name.localeCompare(right.name)
    }
    if (option === 'modified_desc') {
      return parseModifiedAt(right.modified_at) - parseModifiedAt(left.modified_at)
    }

    return left.name.localeCompare(right.name)
  })
}

export function formatSize(size: number): string {
  if (!size) {
    return '--'
  }

  const units = ['B', 'KB', 'MB', 'GB']
  let value = size
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  if (unitIndex === 0) {
    return `${Math.round(value)} ${units[unitIndex]}`
  }

  return `${value.toFixed(1)} ${units[unitIndex]}`
}

export function formatModifiedAt(modifiedAt?: string | null): string {
  if (!modifiedAt) {
    return '--'
  }

  const date = new Date(modifiedAt)
  if (Number.isNaN(date.getTime())) {
    return '--'
  }

  return date.toLocaleString()
}

export function getParentPath(rootPath: string, currentPath: string): string | null {
  if (currentPath === rootPath) {
    return null
  }

  const lastSlash = currentPath.lastIndexOf('/')
  if (lastSlash <= 0) {
    return rootPath
  }

  const parentPath = currentPath.slice(0, lastSlash)
  if (!parentPath || parentPath.length < rootPath.length) {
    return rootPath
  }

  return parentPath
}

export type BreadcrumbSegment = {
  label: string
  path: string
}

export function buildBreadcrumbSegments(
  rootPath: string,
  currentPath: string
): BreadcrumbSegment[] {
  const rootLabel = rootPath.split('/').filter(Boolean).at(-1) || 'workspace'
  const segments: BreadcrumbSegment[] = [{ label: rootLabel, path: rootPath }]

  if (currentPath === rootPath) {
    return segments
  }

  const rootParts = rootPath.split('/').filter(Boolean)
  const currentParts = currentPath.split('/').filter(Boolean)
  let pathBuilder = rootPath

  for (let index = rootParts.length; index < currentParts.length; index += 1) {
    pathBuilder = `${pathBuilder}/${currentParts[index]}`
    segments.push({
      label: currentParts[index],
      path: pathBuilder,
    })
  }

  return segments
}

export function normalizeWorkspacePathInput(
  rootPath: string,
  currentPath: string,
  rawInput: string
): string | null {
  const trimmedInput = rawInput.trim()
  if (!trimmedInput) {
    return null
  }

  const basePath = trimmedInput.startsWith('/') ? trimmedInput : `${currentPath}/${trimmedInput}`
  const segments = basePath.split('/')
  const normalizedSegments: string[] = []

  for (const segment of segments) {
    if (!segment || segment === '.') {
      continue
    }
    if (segment === '..') {
      normalizedSegments.pop()
      continue
    }
    normalizedSegments.push(segment)
  }

  const normalizedPath = `/${normalizedSegments.join('/')}`
  const normalizedRoot = rootPath.replace(/\/+$/, '') || '/'

  if (normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath
  }

  return null
}

const CRC32_TABLE = new Uint32Array(256)

for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  CRC32_TABLE[index] = value >>> 0
}

function calculateCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function writeUint16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >>> 8) & 0xff
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >>> 8) & 0xff
  target[offset + 2] = (value >>> 16) & 0xff
  target[offset + 3] = (value >>> 24) & 0xff
}

function encodeUtf8(value: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value)
  }

  const bytes: number[] = []
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x7f) {
      bytes.push(codePoint)
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f))
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      )
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      )
    }
  }
  return new Uint8Array(bytes)
}

export type ZipFileInput = {
  name: string
  data: Uint8Array
}

function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return copy.buffer
}

export function createStoredZip(files: ZipFileInput[]): Blob {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let localOffset = 0

  for (const file of files) {
    const nameBytes = encodeUtf8(file.name)
    const crc32 = calculateCrc32(file.data)
    const localHeader = new Uint8Array(30 + nameBytes.length)

    writeUint32(localHeader, 0, 0x04034b50)
    writeUint16(localHeader, 4, 20)
    writeUint16(localHeader, 6, 0x0800)
    writeUint16(localHeader, 8, 0)
    writeUint16(localHeader, 10, 0)
    writeUint16(localHeader, 12, 0)
    writeUint32(localHeader, 14, crc32)
    writeUint32(localHeader, 18, file.data.length)
    writeUint32(localHeader, 22, file.data.length)
    writeUint16(localHeader, 26, nameBytes.length)
    writeUint16(localHeader, 28, 0)
    localHeader.set(nameBytes, 30)

    const centralHeader = new Uint8Array(46 + nameBytes.length)
    writeUint32(centralHeader, 0, 0x02014b50)
    writeUint16(centralHeader, 4, 20)
    writeUint16(centralHeader, 6, 20)
    writeUint16(centralHeader, 8, 0x0800)
    writeUint16(centralHeader, 10, 0)
    writeUint16(centralHeader, 12, 0)
    writeUint16(centralHeader, 14, 0)
    writeUint32(centralHeader, 16, crc32)
    writeUint32(centralHeader, 20, file.data.length)
    writeUint32(centralHeader, 24, file.data.length)
    writeUint16(centralHeader, 28, nameBytes.length)
    writeUint16(centralHeader, 30, 0)
    writeUint16(centralHeader, 32, 0)
    writeUint16(centralHeader, 34, 0)
    writeUint16(centralHeader, 36, 0)
    writeUint32(centralHeader, 38, 0)
    writeUint32(centralHeader, 42, localOffset)
    centralHeader.set(nameBytes, 46)

    localParts.push(localHeader, file.data)
    centralParts.push(centralHeader)
    localOffset += localHeader.length + file.data.length
  }

  const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const endRecord = new Uint8Array(22)
  writeUint32(endRecord, 0, 0x06054b50)
  writeUint16(endRecord, 8, files.length)
  writeUint16(endRecord, 10, files.length)
  writeUint32(endRecord, 12, centralDirectorySize)
  writeUint32(endRecord, 16, localOffset)

  const blobParts = [...localParts, ...centralParts, endRecord].map(toBlobPart)
  return new Blob(blobParts, { type: 'application/zip' })
}
