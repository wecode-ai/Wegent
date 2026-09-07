import type { RuntimeWorkspaceFileReference } from '@/types/api'
import type { WorkspaceFileApi } from '@/types/workspace-files'
import { joinDevicePath } from './device-workspace-path'

const MAX_WORKSPACE_IMAGE_BYTES = 50 * 1024 * 1024

export type ReadWorkspaceFileChunk = NonNullable<WorkspaceFileApi['readWorkspaceFileChunk']>

function decodeBase64Chunk(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value)
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index)
  }
  return bytes
}

export async function readWorkspaceFileBytes(
  reference: RuntimeWorkspaceFileReference,
  readWorkspaceFileChunk: ReadWorkspaceFileChunk
): Promise<Uint8Array<ArrayBuffer>> {
  const filePath = joinDevicePath(reference.workspace_path, reference.path)
  let bytes: Uint8Array<ArrayBuffer> | null = null
  let offset = 0

  while (true) {
    const result = await readWorkspaceFileChunk(
      reference.device_id,
      filePath,
      offset,
      reference.workspace_path
    )
    if (
      result.offset !== offset ||
      !Number.isSafeInteger(result.size) ||
      result.size < 0 ||
      result.size > MAX_WORKSPACE_IMAGE_BYTES ||
      (bytes !== null && result.size !== bytes.byteLength) ||
      (result.contentBase64.length === 0 && !result.eof)
    ) {
      throw new Error('Executor returned an invalid workspace image chunk')
    }

    bytes ??= new Uint8Array(result.size)
    const chunk = decodeBase64Chunk(result.contentBase64)
    if (offset + chunk.byteLength > bytes.byteLength) {
      throw new Error('Executor returned an oversized workspace image chunk')
    }
    bytes.set(chunk, offset)
    offset += chunk.byteLength
    if (result.eof) break
    if (offset >= bytes.byteLength) {
      throw new Error('Executor returned an incomplete workspace image chunk sequence')
    }
  }

  if (bytes === null || offset !== bytes.byteLength) {
    throw new Error('Workspace image read ended before the complete file was received')
  }
  return bytes
}
