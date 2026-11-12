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

async function readNativeClipboardImage(): Promise<string | null> {
  if (!isElectronRuntime()) return null
  const result = await invokeDesktopHost<unknown>('clipboard.readImage', {})
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
  readClipboardImage: () => Promise<string | null> = readNativeClipboardImage
): Promise<File[]> {
  const unsupported = files.filter(isUnsupportedClipboardImage)
  if (unsupported.length !== 1) return files

  let dataUrl: string | null
  try {
    dataUrl = await readClipboardImage()
  } catch {
    return files
  }
  if (!dataUrl) return files

  const source = unsupported[0]
  const normalized = pngFileFromDataUrl(dataUrl, source)
  if (!normalized) return files
  return files.map(file => (file === source ? normalized : file))
}
