import { invoke } from '@tauri-apps/api/core'
import type {
  WorkspaceFileChunkResponse,
  WorkspaceTextFileResponse,
  WorkspaceTreeResponse,
} from '@/types/workspace-files'

export function listLocalWorkspaceEntries(
  workspaceRoot: string,
  directoryPath: string
): Promise<WorkspaceTreeResponse> {
  return invoke<WorkspaceTreeResponse>('list_local_workspace_entries', {
    workspaceRoot,
    directoryPath,
  })
}

export function readLocalWorkspaceTextFile(
  workspaceRoot: string,
  filePath: string
): Promise<WorkspaceTextFileResponse> {
  return invoke<WorkspaceTextFileResponse>('read_local_workspace_text_file', {
    workspaceRoot,
    filePath,
  })
}

export function readLocalWorkspaceFileChunk(
  workspaceRoot: string,
  filePath: string,
  offset: number
): Promise<WorkspaceFileChunkResponse> {
  return invoke<WorkspaceFileChunkResponse>('read_local_workspace_file_chunk', {
    workspaceRoot,
    filePath,
    offset,
  })
}
