export type { CodeCommentContext } from '@wegent/chat-core/code-comment'

import type {
  WorkspaceFileChunkResponse,
  WorkspaceTextFileResponse,
  WorkspaceTreeResponse,
} from '@wegent/chat-core/workspace-files'
export type {
  WorkspaceFileEntry,
  WorkspaceFileChunkResponse,
  WorkspaceTextFileResponse,
  WorkspaceTreeResponse,
} from '@wegent/chat-core/workspace-files'

export interface WorkspaceFileApi {
  listWorkspaceEntries: (
    deviceId: string,
    path: string,
    workspaceRoot?: string
  ) => Promise<WorkspaceTreeResponse>
  searchWorkspaceEntries?: (
    deviceId: string,
    root: string,
    query: string,
    cancellationToken?: string
  ) => Promise<import('./api').RuntimeWorkspaceSearchResponse>
  readWorkspaceTextFile: (
    deviceId: string,
    filePath: string,
    workspaceRoot: string
  ) => Promise<WorkspaceTextFileResponse>
  writeWorkspaceTextFile?: (
    deviceId: string,
    filePath: string,
    content: string,
    expectedRevision: string
  ) => Promise<WorkspaceTextFileResponse>
  readWorkspaceFileChunk?: (
    deviceId: string,
    filePath: string,
    offset: number,
    workspaceRoot: string
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
  traceId?: string
}

export interface WorkspaceFileOpenRequest extends WorkspaceFileOpenOptions {
  id: number
  path: string
  target?: WorkspaceTarget
}
