import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const MAX_CLIPBOARD_IMAGE_BYTES = 32 * 1024 * 1024

const PNG_PREFIX = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const SUPPORTED_EXTENSIONS = new Map([
  ['image/heic', 'heic'],
  ['image/heif', 'heif'],
  ['image/tif', 'tif'],
  ['image/tiff', 'tiff'],
  ['image/x-tif', 'tif'],
  ['image/x-tiff', 'tiff'],
])
const SUPPORTED_FILENAME_EXTENSION = /\.(heic|heif|tif|tiff)$/i
const SIPS_TIMEOUT_MS = 15_000

export interface ClipboardImageConversionOptions {
  platform?: NodeJS.Platform
  runSips?: (inputPath: string, outputPath: string) => Promise<void>
}

function imageExtension(fileName: string, mimeType: string): string | null {
  const filenameExtension = fileName.trim().match(SUPPORTED_FILENAME_EXTENSION)?.[1]
  if (filenameExtension) return filenameExtension.toLowerCase()
  return SUPPORTED_EXTENSIONS.get(mimeType.trim().toLowerCase()) ?? null
}

function decodeCanonicalBase64(value: string): Buffer | null {
  const maxEncodedLength = Math.ceil(MAX_CLIPBOARD_IMAGE_BYTES / 3) * 4
  if (
    !value ||
    value.length > maxEncodedLength ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    return null
  }
  const bytes = Buffer.from(value, 'base64')
  if (
    bytes.toString('base64') !== value ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_CLIPBOARD_IMAGE_BYTES
  ) {
    return null
  }
  return bytes
}

function runMacosSips(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/sips',
      ['-s', 'format', 'png', inputPath, '--out', outputPath],
      { timeout: SIPS_TIMEOUT_MS },
      error => {
        if (error) reject(error)
        else resolve()
      }
    )
  })
}

/**
 * Converts the exact bytes supplied by the renderer. macOS clipboard-history
 * applications commonly expose TIFF files that Chromium and nativeImage cannot
 * decode, while the system image pipeline can.
 */
export async function clipboardImageToPngDataUrl(
  dataBase64: string,
  fileName: string,
  mimeType: string,
  options: ClipboardImageConversionOptions = {}
): Promise<string | null> {
  if ((options.platform ?? process.platform) !== 'darwin') return null
  const extension = imageExtension(fileName, mimeType)
  const source = decodeCanonicalBase64(dataBase64)
  if (!extension || !source) return null

  const directory = await mkdtemp(join(tmpdir(), 'wework-clipboard-image-'))
  const inputPath = join(directory, `source.${extension}`)
  const outputPath = join(directory, 'preview.png')
  try {
    await writeFile(inputPath, source, { mode: 0o600 })
    await (options.runSips ?? runMacosSips)(inputPath, outputPath)
    const png = await readFile(outputPath)
    if (png.byteLength < PNG_PREFIX.byteLength || !png.subarray(0, 8).equals(PNG_PREFIX)) {
      return null
    }
    return `data:image/png;base64,${png.toString('base64')}`
  } catch {
    return null
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
