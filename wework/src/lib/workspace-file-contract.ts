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

type WorkspacePathRoot =
  | { kind: 'posix'; prefix: '/' }
  | { kind: 'drive'; prefix: string }
  | { kind: 'unc'; prefix: string }

function normalizeWorkspaceSeparators(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/')
  if (/^\/\/\?\/UNC\//i.test(normalized)) {
    return `//${normalized.slice(8)}`
  }
  if (/^\/\/\?\//.test(normalized)) {
    return normalized.slice(4)
  }
  return normalized
}

function workspacePathRoot(path: string): WorkspacePathRoot | null {
  if (path.startsWith('//')) {
    const [server, share] = path.slice(2).split('/')
    if (!server || !share) return null
    return { kind: 'unc', prefix: `//${server}/${share}` }
  }

  const driveMatch = path.match(/^([a-z]):\//i)
  if (driveMatch) {
    return { kind: 'drive', prefix: `${driveMatch[1].toUpperCase()}:/` }
  }

  return path.startsWith('/') ? { kind: 'posix', prefix: '/' } : null
}

function workspacePathSegments(path: string, root: WorkspacePathRoot): string[] {
  if (root.kind === 'posix') return path.slice(1).split('/')
  if (root.kind === 'drive') return path.slice(3).split('/')
  return path.slice(root.prefix.length).replace(/^\/+/, '').split('/')
}

function buildWorkspacePath(root: WorkspacePathRoot, segments: string[]): string {
  if (root.kind === 'posix') return segments.length > 0 ? `/${segments.join('/')}` : '/'
  if (root.kind === 'drive') return `${root.prefix}${segments.join('/')}`
  return segments.length > 0 ? `${root.prefix}/${segments.join('/')}` : root.prefix
}

function isWindowsWorkspacePath(path: string): boolean {
  const root = workspacePathRoot(path)
  return root?.kind === 'drive' || root?.kind === 'unc'
}

function comparableWorkspacePath(path: string): string {
  return isWindowsWorkspacePath(path) ? path.toLowerCase() : path
}

function workspacePathLeafMatches(leftPath: string, rightPath: string): boolean {
  const leftLeaf = leftPath.split('/').pop() ?? ''
  const rightLeaf = rightPath.split('/').pop() ?? ''
  const windowsPaths = isWindowsWorkspacePath(leftPath) && isWindowsWorkspacePath(rightPath)
  return windowsPaths ? leftLeaf.toLowerCase() === rightLeaf.toLowerCase() : leftLeaf === rightLeaf
}

function formatRequestedWorkspacePath(normalizedPath: string, requestedPath: string): string {
  return requestedPath.trim().includes('\\') ? normalizedPath.replace(/\//g, '\\') : normalizedPath
}

function appendWorkspacePathSuffix(rootPath: string, suffix: string): string {
  return `${rootPath}${rootPath.includes('\\') ? suffix.replace(/\//g, '\\') : suffix}`
}

export function isAbsoluteWorkspacePath(path: string): boolean {
  return workspacePathRoot(normalizeWorkspaceSeparators(path)) !== null
}

export function normalizeAbsoluteWorkspacePath(path: string, errorMessage: string): string {
  const normalizedPath = normalizeWorkspaceSeparators(path)
  const root = workspacePathRoot(normalizedPath)
  if (!root) {
    throw new Error(errorMessage)
  }

  const normalizedSegments: string[] = []

  for (const segment of workspacePathSegments(normalizedPath, root)) {
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

  return buildWorkspacePath(root, normalizedSegments)
}

function isWorkspacePathWithin(path: string, rootPath: string): boolean {
  const comparablePath = comparableWorkspacePath(path)
  const comparableRoot = comparableWorkspacePath(rootPath)
  return (
    comparablePath === comparableRoot ||
    comparablePath.startsWith(`${comparableRoot.replace(/\/+$/, '')}/`)
  )
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
  const requestedPath = appendWorkspacePathSuffix(
    requestedRootPath,
    path.slice(responseRootPath.length)
  )
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
  if (!workspacePathLeafMatches(path, normalizedRequestedPath)) {
    throw new Error('Invalid workspace tree response')
  }
  const formattedRequestedPath = formatRequestedWorkspacePath(
    normalizedRequestedPath,
    requestedPath
  )
  return {
    path: formattedRequestedPath,
    entries: record.entries.map(entry =>
      normalizeWorkspaceEntry(entry, path, formattedRequestedPath)
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
    path: formatRequestedWorkspacePath(normalizedRequestedFilePath, requestedFilePath),
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
    path: formatRequestedWorkspacePath(normalizedRequestedFilePath, requestedFilePath),
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
  const parentPath =
    separatorIndex === 2 && /^[A-Z]:\//.test(normalizedFilePath)
      ? normalizedFilePath.slice(0, 3)
      : separatorIndex > 0
        ? normalizedFilePath.slice(0, separatorIndex)
        : '/'
  const fileName =
    separatorIndex >= 0 ? normalizedFilePath.slice(separatorIndex + 1) : normalizedFilePath
  if (!fileName) {
    throw new Error('Workspace file name is required')
  }
  return { parentPath, fileName }
}
