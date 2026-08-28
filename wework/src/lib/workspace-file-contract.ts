import type {
  WorkspaceFileChunkResponse,
  WorkspaceFileEntry,
  WorkspaceTextFileResponse,
  WorkspaceTreeResponse,
} from '@/types/workspace-files'

function requireRecord(value: unknown, errorMessage: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(errorMessage)
  }
  return value as Record<string, unknown>
}

function normalizeModifiedAt(value: unknown, errorMessage: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  throw new Error(errorMessage)
}

export function normalizeAbsoluteWorkspacePath(path: string, errorMessage: string): string {
  const normalizedSegments: string[] = []
  const normalizedPath = path.trim().replace(/\/+/g, '/')
  if (!normalizedPath.startsWith('/')) {
    throw new Error(errorMessage)
  }

  for (const segment of normalizedPath.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (normalizedSegments.length === 0) {
        throw new Error(errorMessage)
      }
      normalizedSegments.pop()
      continue
    }
    normalizedSegments.push(segment)
  }

  return `/${normalizedSegments.join('/')}`
}

function isWorkspacePathWithin(path: string, rootPath: string): boolean {
  return path === rootPath || path.startsWith(`${rootPath.replace(/\/+$/, '')}/`)
}

function requireWorkspacePathWithin(path: string, rootPath: string, errorMessage: string) {
  if (!isWorkspacePathWithin(path, rootPath)) {
    throw new Error(errorMessage)
  }
}

function normalizeWorkspaceEntry(
  value: unknown,
  responseRootPath: string,
  requestedRootPath: string
): WorkspaceFileEntry {
  const record = requireRecord(value, 'Invalid workspace tree response')
  if (
    typeof record.name !== 'string' ||
    typeof record.path !== 'string' ||
    typeof record.is_directory !== 'boolean' ||
    typeof record.size !== 'number'
  ) {
    throw new Error('Invalid workspace tree response')
  }
  const path = normalizeAbsoluteWorkspacePath(record.path, 'Invalid workspace tree response')
  requireWorkspacePathWithin(path, responseRootPath, 'Invalid workspace tree response')
  const requestedPath = `${requestedRootPath}${path.slice(responseRootPath.length)}`
  return {
    name: record.name,
    path: requestedPath,
    isDirectory: record.is_directory,
    size: record.size,
    modifiedAt: normalizeModifiedAt(record.modified_at, 'Invalid workspace tree response'),
  }
}

export function normalizeWorkspaceTree(
  output: unknown,
  requestedPath: string
): WorkspaceTreeResponse {
  const normalizedRequestedPath = normalizeAbsoluteWorkspacePath(
    requestedPath,
    'Workspace path must be absolute'
  )
  const record = requireRecord(output, 'Invalid workspace tree response')
  if (typeof record.path !== 'string' || !Array.isArray(record.entries)) {
    throw new Error('Invalid workspace tree response')
  }
  const path = normalizeAbsoluteWorkspacePath(record.path, 'Invalid workspace tree response')
  if (path.split('/').pop() !== normalizedRequestedPath.split('/').pop()) {
    throw new Error('Invalid workspace tree response')
  }
  return {
    path: normalizedRequestedPath,
    entries: record.entries.map(entry =>
      normalizeWorkspaceEntry(entry, path, normalizedRequestedPath)
    ),
  }
}

export function normalizeWorkspaceTextFile(
  output: unknown,
  requestedFilePath: string
): WorkspaceTextFileResponse {
  const normalizedRequestedFilePath = normalizeAbsoluteWorkspacePath(
    requestedFilePath,
    'Workspace file path must be absolute'
  )
  const record = requireRecord(output, 'Invalid workspace text file response')
  if (
    typeof record.path !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.content !== 'string' ||
    typeof record.truncated !== 'boolean' ||
    typeof record.size !== 'number'
  ) {
    throw new Error('Invalid workspace text file response')
  }
  const responsePath = normalizeAbsoluteWorkspacePath(
    record.path,
    'Invalid workspace text file response'
  )
  const requestedName = normalizedRequestedFilePath.split('/').pop()
  if (record.name !== requestedName || responsePath.split('/').pop() !== requestedName) {
    throw new Error('Invalid workspace text file response')
  }
  return {
    path: normalizedRequestedFilePath,
    name: record.name,
    content: record.content,
    editable: record.editable === true && typeof record.revision === 'string',
    revision: typeof record.revision === 'string' ? record.revision : '',
    truncated: record.truncated,
    size: record.size,
    modifiedAt: normalizeModifiedAt(record.modified_at, 'Invalid workspace text file response'),
  }
}

export function normalizeWorkspaceFileChunk(
  output: unknown,
  requestedFilePath: string,
  requestedOffset: number
): WorkspaceFileChunkResponse {
  const normalizedRequestedFilePath = normalizeAbsoluteWorkspacePath(
    requestedFilePath,
    'Workspace file path must be absolute'
  )
  const record = requireRecord(output, 'Invalid workspace file chunk response')
  if (
    typeof record.path !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.content_base64 !== 'string' ||
    typeof record.offset !== 'number' ||
    typeof record.eof !== 'boolean' ||
    typeof record.size !== 'number'
  ) {
    throw new Error('Invalid workspace file chunk response')
  }
  const responsePath = normalizeAbsoluteWorkspacePath(
    record.path,
    'Invalid workspace file chunk response'
  )
  const requestedName = normalizedRequestedFilePath.split('/').pop()
  if (
    record.name !== requestedName ||
    responsePath.split('/').pop() !== requestedName ||
    record.offset !== requestedOffset
  ) {
    throw new Error('Invalid workspace file chunk response')
  }
  return {
    path: normalizedRequestedFilePath,
    name: record.name,
    contentBase64: record.content_base64,
    offset: record.offset,
    eof: record.eof,
    size: record.size,
    modifiedAt: normalizeModifiedAt(record.modified_at, 'Invalid workspace file chunk response'),
  }
}

export function splitAbsoluteWorkspaceFilePath(filePath: string): {
  parentPath: string
  fileName: string
} {
  const normalizedFilePath = normalizeAbsoluteWorkspacePath(
    filePath,
    'Workspace file path must be absolute'
  )
  const separatorIndex = normalizedFilePath.lastIndexOf('/')
  const parentPath = separatorIndex > 0 ? normalizedFilePath.slice(0, separatorIndex) : '/'
  const fileName =
    separatorIndex >= 0 ? normalizedFilePath.slice(separatorIndex + 1) : normalizedFilePath
  if (!fileName) {
    throw new Error('Workspace file name is required')
  }
  return { parentPath, fileName }
}
