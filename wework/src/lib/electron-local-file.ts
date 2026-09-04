import { invokeDesktopHost } from '@/api/dsh/desktopHost'

const ELECTRON_LOCAL_FILE_CHUNK_BYTES = 512 * 1024

interface ElectronLocalFileChunk {
  chunkBase64: string
  bytesRead: number
  eof: boolean
  size: number
}

interface ElectronLocalFileReadOptions {
  expectedSize?: number
  maxBytes?: number
}

function decodeBase64Chunk(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value)
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index)
  }
  return bytes
}

export async function readElectronLocalFile(
  path: string,
  options: ElectronLocalFileReadOptions = {}
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  let expectedSize: number | null = null

  if (
    options.expectedSize !== undefined &&
    (!Number.isSafeInteger(options.expectedSize) || options.expectedSize < 0)
  ) {
    throw new Error('Expected Electron local file size must be a non-negative safe integer')
  }
  if (
    options.maxBytes !== undefined &&
    (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
  ) {
    throw new Error('Electron local file size limit must be a non-negative safe integer')
  }

  while (expectedSize === null || offset < expectedSize) {
    const result = await invokeDesktopHost<ElectronLocalFileChunk>('filesystem.readFileChunk', {
      path,
      offset,
      length: ELECTRON_LOCAL_FILE_CHUNK_BYTES,
    })
    if (
      !Number.isSafeInteger(result.bytesRead) ||
      result.bytesRead < 0 ||
      result.bytesRead > ELECTRON_LOCAL_FILE_CHUNK_BYTES ||
      !Number.isSafeInteger(result.size) ||
      result.size < 0 ||
      offset + result.bytesRead > result.size ||
      (result.bytesRead === 0 && !result.eof)
    ) {
      throw new Error('Electron returned an invalid local file chunk')
    }

    if (expectedSize !== null && result.size !== expectedSize) {
      throw new Error('Electron local file size changed while it was being read')
    }
    if (options.expectedSize !== undefined && result.size !== options.expectedSize) {
      throw new Error('Electron local file size did not match the expected size')
    }
    if (options.maxBytes !== undefined && result.size > options.maxBytes) {
      throw new Error('Electron local file exceeds the allowed size')
    }
    expectedSize = result.size
    if (result.bytesRead > 0) {
      const chunk = decodeBase64Chunk(result.chunkBase64)
      if (chunk.byteLength !== result.bytesRead) {
        throw new Error('Electron local file chunk length did not match its payload')
      }
      chunks.push(chunk)
      offset += chunk.byteLength
    }
    if (result.eof) break
  }

  if (expectedSize === null || offset !== expectedSize) {
    throw new Error('Electron local file read ended before the complete file was received')
  }

  const bytes = new Uint8Array(expectedSize)
  let writeOffset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, writeOffset)
    writeOffset += chunk.byteLength
  }
  return bytes
}
