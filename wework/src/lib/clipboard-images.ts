import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from './runtime-environment'

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'
const UNSUPPORTED_CLIPBOARD_IMAGE_TYPES = new Set([
  'image/heic',
  'image/heif',
  'image/tif',
  'image/tiff',
  'image/x-tif',
  'image/x-tiff',
])
const UNSUPPORTED_CLIPBOARD_IMAGE_EXTENSION = /\.(?:heic|heif|tif|tiff)$/i

function encodeBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value)
  const chunks: string[] = []
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)))
  }
  return btoa(chunks.join(''))
}

async function convertNativeClipboardImage(file: File): Promise<string | null> {
  if (!isElectronRuntime()) return null
  const result = await invokeDesktopHost<unknown>('clipboard.convertImageToPng', {
    dataBase64: encodeBase64(await file.arrayBuffer()),
    fileName: file.name,
    mimeType: file.type,
  })
  return typeof result === 'string' ? result : null
}

function isUnsupportedClipboardImage(file: File): boolean {
  return (
    UNSUPPORTED_CLIPBOARD_IMAGE_TYPES.has(file.type.toLowerCase()) ||
    UNSUPPORTED_CLIPBOARD_IMAGE_EXTENSION.test(file.name)
  )
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
}

function normalizedPngFilename(filename: string): string {
  const basename = filename.replace(UNSUPPORTED_CLIPBOARD_IMAGE_EXTENSION, '').trim()
  return `${basename || 'clipboard-image'}.png`
}

export function pngFileFromDataUrl(dataUrl: string, source: File): File | null {
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) return null
  try {
    return new File(
      [decodeBase64(dataUrl.slice(PNG_DATA_URL_PREFIX.length))],
      normalizedPngFilename(source.name),
      { type: 'image/png', lastModified: source.lastModified }
    )
  } catch {
    return null
  }
}

/** Converts clipboard-history bitmap formats that Chromium cannot render into a PNG File. */
export async function normalizeClipboardImageFiles(
  files: File[],
  convertClipboardImage: (file: File) => Promise<string | null> = convertNativeClipboardImage
): Promise<File[]> {
  return Promise.all(
    files.map(async file => {
      if (!isUnsupportedClipboardImage(file)) return file
      try {
        const dataUrl = await convertClipboardImage(file)
        return (dataUrl && pngFileFromDataUrl(dataUrl, file)) || file
      } catch {
        return file
      }
    })
  )
}
