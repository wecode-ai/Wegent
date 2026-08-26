import { open } from 'node:fs/promises'

export const MAX_LOCAL_FILE_CHUNK_BYTES = 512 * 1024

export interface LocalFileChunk {
  chunkBase64: string
  bytesRead: number
  eof: boolean
  size: number
}

export async function readLocalFileChunk(
  path: string,
  offset: number,
  length: number
): Promise<LocalFileChunk> {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Local file offset must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_LOCAL_FILE_CHUNK_BYTES) {
    throw new Error(`Local file chunk length must be between 1 and ${MAX_LOCAL_FILE_CHUNK_BYTES}`)
  }

  const file = await open(path, 'r')
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) {
      throw new Error('Local file path is not a regular file')
    }

    const remaining = Math.max(0, metadata.size - offset)
    const requestedBytes = Math.min(length, remaining)
    if (requestedBytes === 0) {
      return {
        chunkBase64: '',
        bytesRead: 0,
        eof: true,
        size: metadata.size,
      }
    }

    const buffer = Buffer.allocUnsafe(requestedBytes)
    const { bytesRead } = await file.read(buffer, 0, requestedBytes, offset)
    return {
      chunkBase64: buffer.subarray(0, bytesRead).toString('base64'),
      bytesRead,
      eof: offset + bytesRead >= metadata.size,
      size: metadata.size,
    }
  } finally {
    await file.close()
  }
}
