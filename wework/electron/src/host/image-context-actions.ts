import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join } from 'node:path'
import type { WebContents } from 'electron'
import type { ImageContext, NativeContextMenuParams } from './image-context-menu.js'

const MAX_IMAGE_BYTES = 100 * 1024 * 1024
const IMAGE_EXTENSION_BY_MIME_TYPE: Readonly<Record<string, string>> = {
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
}

interface RendererImageContext {
  filename?: unknown
  localPath?: unknown
  sourceUrl?: unknown
}

function rendererImageContextExpression(params: NativeContextMenuParams): string {
  return `(() => {
    const element = document.elementFromPoint(${JSON.stringify(params.x)}, ${JSON.stringify(
      params.y
    )})
    const image = element instanceof Element ? element.closest('img') : null
    if (!(image instanceof HTMLImageElement)) return null
    return {
      filename: image.dataset.contextImageFilename || image.alt || 'image',
      localPath: image.dataset.contextImageLocalPath || null,
      sourceUrl: image.currentSrc || image.src || '',
    }
  })()`
}

export async function resolveRendererImageContext(
  contents: WebContents,
  params: NativeContextMenuParams
): Promise<ImageContext | null> {
  const value = (await contents.executeJavaScript(
    rendererImageContextExpression(params),
    true
  )) as RendererImageContext | null
  if (!value || typeof value.sourceUrl !== 'string' || !value.sourceUrl) return null

  const localPath =
    typeof value.localPath === 'string' && isAbsolute(value.localPath) ? value.localPath : null
  const filename =
    typeof value.filename === 'string' && value.filename.trim()
      ? basename(value.filename.trim())
      : 'image'
  return { filename, localPath, sourceUrl: value.sourceUrl }
}

function imageDataUrlExpression(sourceUrl: string): string {
  return `(async () => {
    const response = await fetch(${JSON.stringify(sourceUrl)})
    if (!response.ok) throw new Error('Failed to read image: ' + response.status)
    const blob = await response.blob()
    return await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(reader.error || new Error('Failed to encode image'))
      reader.readAsDataURL(blob)
    })
  })()`
}

function decodeImageDataUrl(dataUrl: string): { bytes: Buffer; mimeType: string } {
  const match = /^data:([^;,]+)(?:;[^;,]+)*;base64,([a-zA-Z0-9+/=\s]+)$/.exec(dataUrl)
  if (!match) throw new Error('Renderer returned an invalid image data URL')

  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image size is outside the supported range: ${bytes.length}`)
  }
  return { bytes, mimeType: match[1].toLowerCase() }
}

function temporaryImageFilename(filename: string, mimeType: string): string {
  const safeFilename = basename(filename).replaceAll(/[^a-zA-Z0-9._ -]/g, '_')
  if (safeFilename && extname(safeFilename)) return safeFilename
  const extension = IMAGE_EXTENSION_BY_MIME_TYPE[mimeType] ?? '.png'
  return `${safeFilename || 'image'}${extension}`
}

export async function materializeTemporaryImage(
  contents: WebContents,
  image: ImageContext
): Promise<string> {
  const dataUrl = await contents.executeJavaScript(imageDataUrlExpression(image.sourceUrl), true)
  if (typeof dataUrl !== 'string') throw new Error('Renderer did not return image data')

  const { bytes, mimeType } = decodeImageDataUrl(dataUrl)
  const directory = await mkdtemp(join(tmpdir(), 'wework-image-preview-'))
  const path = join(directory, temporaryImageFilename(image.filename, mimeType))
  await writeFile(path, bytes, { flag: 'wx' })
  return path
}
