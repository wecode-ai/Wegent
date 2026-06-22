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
  truncated: boolean
  size: number
  modifiedAt?: string | null
}

export interface WorkspaceTarget {
  deviceId: string
  path: string
  source: 'project' | 'runtime'
}

export interface WorkspaceFileOpenRequest {
  id: number
  path: string
}

export interface CodeCommentContext {
  id: string
  filePath: string
  fileName: string
  startLine: number
  endLine: number
  selectedText: string
  comment: string
  createdAt: string
}
