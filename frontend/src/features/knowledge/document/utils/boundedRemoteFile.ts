// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { DocumentLinkPreviewKind } from './documentLinkResource'

const MIB = 1024 * 1024
export const MAX_NON_RANGE_VIDEO_BYTES = 20 * MIB
const REMOTE_FILE_TIMEOUT_MS = 20_000
const MAX_IMAGE_PIXELS = 12_000_000
const MAX_OFFICE_ENTRIES = 1_000
const MAX_OFFICE_UNCOMPRESSED_BYTES = 50 * MIB
const MAX_OFFICE_ENTRY_BYTES = 10 * MIB
const MAX_OFFICE_COMPRESSION_RATIO = 100
const MAX_TEXT_LINES = 5_000

const MAX_BYTES: Record<Exclude<DocumentLinkPreviewKind, 'video' | 'unknown'>, number> = {
  pdf: 20 * MIB,
  office: 10 * MIB,
  image: 8 * MIB,
  text: 512 * 1024,
}

export type RemoteFileErrorCode =
  | 'access-denied'
  | 'source-missing'
  | 'network-or-cors'
  | 'too-large'
  | 'too-complex'
  | 'unsupported-type'
  | 'timeout'
  | 'video-range-required'

export class RemoteFileError extends Error {
  constructor(
    public readonly code: RemoteFileErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'RemoteFileError'
  }
}

function assertResponse(response: Response): void {
  if (response.status === 401 || response.status === 403) {
    throw new RemoteFileError('access-denied', 'Remote file access was denied')
  }
  if (response.status === 404 || response.status === 410) {
    throw new RemoteFileError('source-missing', 'Remote file is unavailable')
  }
  if (!response.ok) throw new RemoteFileError('network-or-cors', 'Remote file request failed')
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value)
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error || new Error('Blob could not be read'))
    reader.readAsArrayBuffer(blob)
  })
}

function assertFileSignature(
  kind: Exclude<DocumentLinkPreviewKind, 'video' | 'unknown'>,
  bytes: Uint8Array,
  mimeType: string
): void {
  if (mimeType === 'text/html' || mimeType === 'application/xhtml+xml') {
    throw new RemoteFileError('unsupported-type', 'Remote response is an HTML document')
  }

  const valid = (() => {
    if (kind === 'pdf') return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])
    if (kind === 'office') return startsWith(bytes, [0x50, 0x4b])
    if (kind === 'image') {
      const isJpeg = startsWith(bytes, [0xff, 0xd8, 0xff])
      const isPng = startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const isGif = startsWith(bytes, [0x47, 0x49, 0x46, 0x38])
      const isWebp =
        startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
      return isJpeg || isPng || isGif || isWebp
    }
    return !bytes.includes(0)
  })()

  if (!valid) {
    throw new RemoteFileError('unsupported-type', 'Remote file signature does not match its type')
  }
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function readImageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && bytes.length >= 10) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) && bytes.length >= 24) {
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    const chunk = new TextDecoder('ascii').decode(bytes.subarray(12, 16))
    if (chunk === 'VP8X' && bytes.length >= 30) {
      return {
        width: readUint24LE(bytes, 24) + 1,
        height: readUint24LE(bytes, 27) + 1,
      }
    }
    if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      return {
        width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]),
        height: 1 + ((bytes[24] << 6) | (bytes[23] >> 2)),
      }
    }
    if (
      chunk === 'VP8 ' &&
      bytes.length >= 30 &&
      startsWith(bytes.subarray(23), [0x9d, 0x01, 0x2a])
    ) {
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      }
    }
    return null
  }
  if (!startsWith(bytes, [0xff, 0xd8])) return null

  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    offset += 2
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) return null
    const segmentLength = view.getUint16(offset)
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    if (isStartOfFrame && segmentLength >= 7) {
      return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) }
    }
    offset += segmentLength
  }
  return null
}

async function assertImageComplexity(blob: Blob): Promise<void> {
  const bytes = new Uint8Array(await readBlob(blob.slice(0, 64 * 1024)))
  const dimensions = readImageDimensions(bytes)
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    throw new RemoteFileError('unsupported-type', 'Image dimensions could not be verified')
  }
  if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    throw new RemoteFileError('too-complex', 'Image exceeds the pixel budget')
  }
}

function hasUnsafeArchivePath(filename: string): boolean {
  const normalized = filename.replaceAll('\\', '/')
  return normalized.startsWith('/') || normalized.split('/').includes('..')
}

async function assertOfficeComplexity(blob: Blob, filename: string): Promise<void> {
  const tailLength = Math.min(blob.size, 65_557)
  const tail = new Uint8Array(await readBlob(blob.slice(blob.size - tailLength)))
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let endOffset = -1
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (
      tailView.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + tailView.getUint16(offset + 20, true) === tail.length
    ) {
      endOffset = offset
      break
    }
  }
  if (endOffset < 0) throw new RemoteFileError('unsupported-type', 'Office archive is invalid')

  const entryCount = tailView.getUint16(endOffset + 10, true)
  const entriesOnDisk = tailView.getUint16(endOffset + 8, true)
  const directorySize = tailView.getUint32(endOffset + 12, true)
  const directoryOffset = tailView.getUint32(endOffset + 16, true)
  if (
    tailView.getUint16(endOffset + 4, true) !== 0 ||
    tailView.getUint16(endOffset + 6, true) !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    entryCount > MAX_OFFICE_ENTRIES ||
    directorySize > 2 * MIB ||
    directoryOffset + directorySize > blob.size
  ) {
    throw new RemoteFileError('too-complex', 'Office archive exceeds the structure budget')
  }

  const directory = new Uint8Array(
    await readBlob(blob.slice(directoryOffset, directoryOffset + directorySize))
  )
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength)
  const decoder = new TextDecoder('utf-8')
  const names = new Set<string>()
  let offset = 0
  let totalUncompressed = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > directory.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new RemoteFileError('unsupported-type', 'Office archive directory is invalid')
    }
    const flags = view.getUint16(offset + 8, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const filenameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const nextOffset = offset + 46 + filenameLength + extraLength + commentLength
    if (
      nextOffset > directory.length ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      (flags & 0x1) !== 0
    ) {
      throw new RemoteFileError('unsupported-type', 'Office archive uses unsupported features')
    }
    const entryName = decoder.decode(directory.subarray(offset + 46, offset + 46 + filenameLength))
    if (hasUnsafeArchivePath(entryName)) {
      throw new RemoteFileError('unsupported-type', 'Office archive contains an unsafe path')
    }
    totalUncompressed += uncompressedSize
    const compressionRatio =
      compressedSize === 0 ? uncompressedSize : uncompressedSize / compressedSize
    if (
      uncompressedSize > MAX_OFFICE_ENTRY_BYTES ||
      totalUncompressed > MAX_OFFICE_UNCOMPRESSED_BYTES ||
      compressionRatio > MAX_OFFICE_COMPRESSION_RATIO
    ) {
      throw new RemoteFileError('too-complex', 'Office archive exceeds the expansion budget')
    }
    names.add(entryName)
    offset = nextOffset
  }

  if (offset !== directory.length) {
    throw new RemoteFileError('unsupported-type', 'Office archive directory is inconsistent')
  }

  const extension = filename.split('.').pop()?.toLowerCase()
  const requiredPart =
    extension === 'docx'
      ? 'word/document.xml'
      : extension === 'xlsx'
        ? 'xl/workbook.xml'
        : extension === 'pptx'
          ? 'ppt/presentation.xml'
          : null
  if (!names.has('[Content_Types].xml') || !requiredPart || !names.has(requiredPart)) {
    throw new RemoteFileError('unsupported-type', 'Office archive does not match its extension')
  }
}

async function assertTextComplexity(blob: Blob): Promise<void> {
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(await readBlob(blob))
  } catch {
    throw new RemoteFileError('unsupported-type', 'Text file is not valid UTF-8')
  }
  if (content.split('\n').length > MAX_TEXT_LINES) {
    throw new RemoteFileError('too-complex', 'Text file exceeds the line budget')
  }
}

async function assertFileComplexity(
  kind: Exclude<DocumentLinkPreviewKind, 'video' | 'unknown'>,
  blob: Blob,
  filename: string
): Promise<void> {
  if (kind === 'image') await assertImageComplexity(blob)
  if (kind === 'office') await assertOfficeComplexity(blob, filename)
  if (kind === 'text') await assertTextComplexity(blob)
}

function createTimedSignal(signal: AbortSignal): {
  signal: AbortSignal
  cleanup: () => void
  didTimeout: () => boolean
} {
  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abortFromCaller, { once: true })
  if (signal.aborted) abortFromCaller()
  const timer = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REMOTE_FILE_TIMEOUT_MS)
  return {
    signal: controller.signal,
    cleanup: () => {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', abortFromCaller)
    },
    didTimeout: () => timedOut,
  }
}

export async function loadBoundedRemoteFile(
  url: string,
  kind: Exclude<DocumentLinkPreviewKind, 'video' | 'unknown'>,
  signal: AbortSignal,
  filename = new URL(url).pathname.split('/').pop() || 'file'
): Promise<{ blob: Blob; mimeType: string; size: number }> {
  const maxBytes = MAX_BYTES[kind]
  const timedSignal = createTimedSignal(signal)
  let response: Response
  try {
    response = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: timedSignal.signal,
    })
  } catch (error) {
    timedSignal.cleanup()
    if (timedSignal.didTimeout()) {
      throw new RemoteFileError('timeout', 'Remote file request timed out')
    }
    if (signal.aborted) throw error
    throw new RemoteFileError('network-or-cors', 'Remote file could not be read')
  }
  try {
    assertResponse(response)

    const declaredSize = Number(response.headers.get('content-length') || 0)
    if (declaredSize > maxBytes) {
      await response.body?.cancel()
      throw new RemoteFileError('too-large', 'Remote file exceeds the preview limit')
    }
    if (!response.body) throw new RemoteFileError('network-or-cors', 'Remote file has no body')

    const reader = response.body.getReader()
    const chunks: ArrayBuffer[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) {
          await reader.cancel()
          throw new RemoteFileError('too-large', 'Remote file exceeds the preview limit')
        }
        const copy = new Uint8Array(value.byteLength)
        copy.set(value)
        chunks.push(copy.buffer)
      }
    } finally {
      reader.releaseLock()
    }
    const mimeType = response.headers.get('content-type')?.split(';')[0].trim() || ''
    const blob = new Blob(chunks, { type: mimeType })
    const signature = new Uint8Array(await readBlob(blob.slice(0, 16)))
    assertFileSignature(kind, signature, mimeType)
    await assertFileComplexity(kind, blob, filename)
    return { blob, mimeType, size }
  } catch (error) {
    if (timedSignal.didTimeout()) {
      throw new RemoteFileError('timeout', 'Remote file request timed out')
    }
    throw error
  } finally {
    timedSignal.cleanup()
  }
}

export interface PreparedRemotePdf {
  blob?: Blob
  mimeType: string
  size: number
  supportsRange: boolean
}

async function readResponsePrefix(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) throw new RemoteFileError('network-or-cors', 'Remote file has no body')
  const reader = response.body.getReader()
  const bytes = new Uint8Array(maxBytes)
  let size = 0
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      const length = Math.min(value.byteLength, maxBytes - size)
      bytes.set(value.subarray(0, length), size)
      size += length
      if (length < value.byteLength) {
        await reader.cancel()
        break
      }
    }
    if (size === maxBytes) await reader.cancel()
  } finally {
    reader.releaseLock()
  }
  return bytes.subarray(0, size)
}

/**
 * Validate a PDF without buffering a range-capable file in browser memory.
 * Origins that ignore Range fall back to the normal bounded-file loader.
 */
export async function prepareRemotePdf(
  url: string,
  signal: AbortSignal,
  filename = new URL(url).pathname.split('/').pop() || 'file.pdf'
): Promise<PreparedRemotePdf> {
  const timedSignal = createTimedSignal(signal)
  let useBoundedFallback = false
  try {
    const response = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: { Range: 'bytes=0-' },
      signal: timedSignal.signal,
    })
    assertResponse(response)

    if (response.status !== 206) {
      const declaredSize = Number(response.headers.get('content-length') || 0)
      await response.body?.cancel()
      if (declaredSize > MAX_BYTES.pdf) {
        throw new RemoteFileError('too-large', 'Remote file exceeds the preview limit')
      }
      useBoundedFallback = true
    } else {
      const range = response.headers.get('content-range')
      const match = range?.match(/^bytes\s+0-(\d+)\/(\d+)$/i)
      let end = match ? Number(match[1]) : 0
      const size = match ? Number(match[2]) : Number(response.headers.get('content-length') || 0)
      const mimeType = response.headers.get('content-type')?.split(';')[0].trim() || ''
      const prefix = await readResponsePrefix(response, 16)
      if (!match) end = prefix.length - 1
      if (!Number.isSafeInteger(end) || end < 4) {
        throw new RemoteFileError('network-or-cors', 'Remote PDF range response is invalid')
      }
      assertFileSignature('pdf', prefix, mimeType)

      // Content-Range is not always exposed by CORS. Since the request asks
      // for bytes 0 through EOF, its exposed Content-Length is also a safe
      // total. The body is still cancelled after the signature prefix.
      if (!Number.isSafeInteger(size) || size <= end) {
        throw new RemoteFileError('network-or-cors', 'Remote PDF size could not be verified')
      }
      return {
        mimeType: mimeType || 'application/pdf',
        size,
        supportsRange: true,
      }
    }
  } catch (error) {
    if (timedSignal.didTimeout()) {
      throw new RemoteFileError('timeout', 'Remote PDF request timed out')
    }
    if (signal.aborted || error instanceof RemoteFileError) throw error
    throw new RemoteFileError('network-or-cors', 'Remote PDF could not be read')
  } finally {
    timedSignal.cleanup()
  }

  if (!useBoundedFallback) {
    throw new RemoteFileError('network-or-cors', 'Remote PDF could not be verified')
  }
  const result = await loadBoundedRemoteFile(url, 'pdf', signal, filename)
  return { ...result, supportsRange: false }
}

export async function probeRemoteVideo(
  url: string,
  signal: AbortSignal
): Promise<{ size?: number; supportsRange: boolean }> {
  const timedSignal = createTimedSignal(signal)
  let response: Response
  try {
    response = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: { Range: 'bytes=0-0' },
      signal: timedSignal.signal,
    })
  } catch (error) {
    timedSignal.cleanup()
    if (timedSignal.didTimeout()) {
      throw new RemoteFileError('timeout', 'Remote video request timed out')
    }
    if (signal.aborted) throw error
    // Native media may still be playable when JavaScript cannot read it through CORS.
    return { supportsRange: false }
  }
  try {
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel()
      throw new RemoteFileError('access-denied', 'Remote video access was denied')
    }
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel()
      throw new RemoteFileError('source-missing', 'Remote video is unavailable')
    }

    const range = response.headers.get('content-range')
    const rangeTotal = range?.match(/^bytes\s+0-0\/(\d+)$/i)?.[1]
    const size =
      (rangeTotal ? Number(rangeTotal) : Number(response.headers.get('content-length') || 0)) ||
      undefined
    const supportsRange = response.status === 206 && !!rangeTotal
    await response.body?.cancel()

    if (!supportsRange && size && size > MAX_NON_RANGE_VIDEO_BYTES) {
      throw new RemoteFileError(
        'video-range-required',
        'Large videos must support byte range requests'
      )
    }
    return { size, supportsRange }
  } finally {
    timedSignal.cleanup()
  }
}
