import type { BrowserAnnotationContextData, StyleAdjustment } from './browser-annotation'

export interface WorkspaceFileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifiedAt?: string | null
}

export interface WorkspaceTreeResponse {
  path: string
  entries: WorkspaceFileEntry[]
}

export interface WorkspaceTextFileResponse {
  path: string
  name: string
  content: string
  editable: boolean
  revision: string
  truncated: boolean
  size: number
  modifiedAt?: string | null
}

export interface WorkspaceFileChunkResponse {
  path: string
  name: string
  contentBase64: string
  offset: number
  eof: boolean
  size: number
  modifiedAt?: string | null
}

export interface WorkspaceFileApi {
  listWorkspaceEntries: (deviceId: string, path: string) => Promise<WorkspaceTreeResponse>
  searchWorkspaceEntries?: (
    deviceId: string,
    root: string,
    query: string,
    cancellationToken?: string
  ) => Promise<import('./api').RuntimeWorkspaceSearchResponse>
  readWorkspaceTextFile: (deviceId: string, filePath: string) => Promise<WorkspaceTextFileResponse>
  writeWorkspaceTextFile?: (
    deviceId: string,
    filePath: string,
    content: string,
    expectedRevision: string
  ) => Promise<WorkspaceTextFileResponse>
  readWorkspaceFileChunk?: (
    deviceId: string,
    filePath: string,
    offset: number
  ) => Promise<WorkspaceFileChunkResponse>
}

export interface WorkspaceTarget {
  deviceId: string
  path: string
  source: 'project' | 'runtime'
  taskId?: string | null
  workspaceSource?: 'local' | 'remote' | string | null
}

export interface WorkspaceFileOpenOptions {
  lineStart?: number
  lineEnd?: number
  isDirectory?: boolean
}

export interface WorkspaceFileOpenRequest extends WorkspaceFileOpenOptions {
  id: number
  path: string
  target?: WorkspaceTarget
}

export interface CodeCommentContext {
  id: string
  source?: 'browser_annotation' | 'code_selection'
  filePath: string
  fileName: string
  startLine: number
  endLine: number
  selectedText: string
  comment: string
  createdAt: string
  updatedAt?: string
  browserAnnotation?: BrowserAnnotationContextData
  adjustments?: StyleAdjustment[]
}
