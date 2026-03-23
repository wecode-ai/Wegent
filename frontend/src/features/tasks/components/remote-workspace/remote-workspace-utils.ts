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
