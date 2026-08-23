import { invoke } from '@tauri-apps/api/core'
import type { DeviceCommandResponse } from '@/types/api'
import type {
  WorkspaceFileChunkResponse,
  WorkspaceTextFileResponse,
  WorkspaceTreeResponse,
} from '@/types/workspace-files'
import {
  normalizeWorkspaceFileChunk,
  normalizeWorkspaceTextFile,
  normalizeWorkspaceTree,
  splitAbsoluteWorkspaceFilePath,
} from '@/lib/workspace-file-contract'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { requestLocalExecutor } from './localExecutor'

const WORKSPACE_ROOTS_ENV = 'WEGENT_WORKSPACE_ROOTS'
const WORKSPACE_TEXT_FILE_MAX_OUTPUT_BYTES = 1024 * 1024 * 2

function assertCommandSuccess(response: DeviceCommandResponse, fallbackMessage: string): void {
  if (!response.success) {
    throw new Error(response.error || response.stderr || fallbackMessage)
  }
}

function executeWorkspaceCommand(
  workspaceRoot: string,
  params: {
    command_key: string
    path: string
    args?: string[]
    timeout_seconds: number
    max_output_bytes: number
  }
): Promise<DeviceCommandResponse> {
  return requestLocalExecutor<DeviceCommandResponse>('device.execute_command', {
    ...params,
    env: {
      [WORKSPACE_ROOTS_ENV]: workspaceRoot,
    },
  })
}

export async function listLocalWorkspaceEntries(
  workspaceRoot: string,
  directoryPath: string
): Promise<WorkspaceTreeResponse> {
  if (isElectronRuntime()) {
    const response = await executeWorkspaceCommand(workspaceRoot, {
      command_key: 'workspace_tree',
      path: directoryPath,
      timeout_seconds: 15,
      max_output_bytes: 1024 * 512,
    })
    assertCommandSuccess(response, 'Failed to list workspace files')
    return normalizeWorkspaceTree(response.stdout, directoryPath)
  }
  return invoke<WorkspaceTreeResponse>('list_local_workspace_entries', {
    workspaceRoot,
    directoryPath,
  })
}

export async function readLocalWorkspaceTextFile(
  workspaceRoot: string,
  filePath: string
): Promise<WorkspaceTextFileResponse> {
  if (isElectronRuntime()) {
    const { parentPath, fileName } = splitAbsoluteWorkspaceFilePath(filePath)
    const response = await executeWorkspaceCommand(workspaceRoot, {
      command_key: 'workspace_read_text_file',
      path: parentPath,
      args: [fileName],
      timeout_seconds: 15,
      max_output_bytes: WORKSPACE_TEXT_FILE_MAX_OUTPUT_BYTES,
    })
    assertCommandSuccess(response, 'Failed to read workspace file')
    return normalizeWorkspaceTextFile(response.stdout, filePath)
  }
  return invoke<WorkspaceTextFileResponse>('read_local_workspace_text_file', {
    workspaceRoot,
    filePath,
  })
}

export async function readLocalWorkspaceFileChunk(
  workspaceRoot: string,
  filePath: string,
  offset: number
): Promise<WorkspaceFileChunkResponse> {
  if (isElectronRuntime()) {
    const { parentPath, fileName } = splitAbsoluteWorkspaceFilePath(filePath)
    const response = await executeWorkspaceCommand(workspaceRoot, {
      command_key: 'workspace_read_file_chunk',
      path: parentPath,
      args: [fileName, String(offset)],
      timeout_seconds: 30,
      max_output_bytes: 1024 * 1024 * 2,
    })
    assertCommandSuccess(response, 'Failed to read workspace file')
    return normalizeWorkspaceFileChunk(response.stdout, filePath, offset)
  }
  return invoke<WorkspaceFileChunkResponse>('read_local_workspace_file_chunk', {
    workspaceRoot,
    filePath,
    offset,
  })
}
