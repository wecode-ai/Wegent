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
  const response = await executeWorkspaceCommand(workspaceRoot, {
    command_key: 'workspace_tree',
    path: directoryPath,
    timeout_seconds: 15,
    max_output_bytes: 1024 * 512,
  })
  assertCommandSuccess(response, 'Failed to list workspace files')
  return normalizeWorkspaceTree(response.stdout, directoryPath)
}

export async function readLocalWorkspaceTextFile(
  workspaceRoot: string,
  filePath: string
): Promise<WorkspaceTextFileResponse> {
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

export async function readLocalWorkspaceFileChunk(
  workspaceRoot: string,
  filePath: string,
  offset: number
): Promise<WorkspaceFileChunkResponse> {
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
