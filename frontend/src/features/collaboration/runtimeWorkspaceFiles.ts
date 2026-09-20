import { deviceApis } from '@/apis/devices'
import type { RuntimeWorkspaceFileReference } from '@wegent/chat-core/runtime'
import { readWorkspaceFileBytes } from '@wegent/chat-core/workspace-file-bytes'
import {
  normalizeWorkspaceFileChunk,
  splitAbsoluteWorkspaceFilePath,
} from '@wegent/chat-core/workspace-file-contract'

/** The same executor command and chunk validation used by the PC file reader. */
export async function readRuntimeWorkspaceFile(
  reference: RuntimeWorkspaceFileReference,
  mimeType = 'application/octet-stream'
): Promise<Blob> {
  const bytes = await readWorkspaceFileBytes(reference, async (deviceId, filePath, offset) => {
    const { parentPath, fileName } = splitAbsoluteWorkspaceFilePath(filePath)
    const response = await deviceApis.executeCommand<unknown>(deviceId, {
      command_key: 'workspace_read_file_chunk',
      path: parentPath,
      args: [fileName, String(offset)],
      timeout_seconds: 30,
      max_output_bytes: 1024 * 1024 * 2,
    })
    if (!response.success) {
      throw new Error(response.error || response.stderr || 'Failed to read workspace file')
    }
    return normalizeWorkspaceFileChunk(response.stdout, filePath, offset)
  })
  return new Blob([bytes], { type: mimeType })
}
