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
