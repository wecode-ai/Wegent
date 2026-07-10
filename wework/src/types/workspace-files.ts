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

export interface WorkspaceFileApi {
  listWorkspaceEntries: (deviceId: string, path: string) => Promise<WorkspaceTreeResponse>
  readWorkspaceTextFile: (deviceId: string, filePath: string) => Promise<WorkspaceTextFileResponse>
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
}

export interface WorkspaceFileOpenRequest extends WorkspaceFileOpenOptions {
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
