import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { app, clipboard, Menu, shell, type WebContents } from 'electron'
import {
  installNativeContextMenu,
  type ImageContext,
  type NativeContextMenuActions,
  type NativeContextMenuMode,
  type NativeContextMenuParams,
} from './image-context-menu.js'

export function createNativeContextMenuActions(
  contents: WebContents,
  openLinkInNewTab: (url: string) => void = url => {
    void shell.openExternal(url)
  }
): NativeContextMenuActions {
  return {
    copyLink: url => clipboard.writeText(url),
    copyPath: path => clipboard.writeText(path),
    getState: () => ({
      canGoBack: !contents.isDestroyed() && contents.canGoBack(),
      canGoForward: !contents.isDestroyed() && contents.canGoForward(),
    }),
    goBack: () => {
      if (!contents.isDestroyed() && contents.canGoBack()) contents.goBack()
    },
    goForward: () => {
      if (!contents.isDestroyed() && contents.canGoForward()) contents.goForward()
    },
    inspect: (x, y) => {
      if (contents.isDestroyed()) return
      contents.inspectElement(x, y)
      if (!contents.isDevToolsOpened()) contents.openDevTools({ mode: 'detach' })
    },
    openExternal: url => {
      void shell.openExternal(url)
    },
    openImage: async image => {
      const temporaryPath = image.localPath
        ? null
        : await materializeTemporaryImage(contents, image)
      const path = image.localPath ?? temporaryPath
      if (!path) throw new Error('Image path is unavailable')
      const error = await shell.openPath(path)
      if (temporaryPath) scheduleTemporaryImageCleanup(temporaryPath)
      if (error) throw new Error(error)
    },
    openLinkInNewTab,
    reloadPage: () => {
      if (!contents.isDestroyed()) contents.reload()
    },
    reportError: (action, error) => {
      console.error(`[context-menu] ${action} failed`, error)
    },
    resolveImageContext: params => resolveRendererImageContext(contents, params),
    showItemInFolder: path => shell.showItemInFolder(path),
  }
}

export function installContextMenu(
  contents: WebContents,
  mode: NativeContextMenuMode,
  actions: NativeContextMenuActions = createNativeContextMenuActions(contents)
): void {
  installNativeContextMenu(
    contents,
    items => Menu.buildFromTemplate(items),
    actions,
    app.getLocale(),
    mode
  )
}

const MAX_IMAGE_BYTES = 100 * 1024 * 1024
const TEMPORARY_IMAGE_DIRECTORY_PREFIX = 'wework-image-preview-'
const TEMPORARY_IMAGE_CLEANUP_DELAY_MS = 15 * 60 * 1000
const STALE_TEMPORARY_IMAGE_AGE_MS = 24 * 60 * 60 * 1000
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
    if (!response.body) throw new Error('Image response body is unavailable')
    const reader = response.body.getReader()
    const chunks = []
    let totalBytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > ${MAX_IMAGE_BYTES}) {
        await reader.cancel()
        throw new Error('Image exceeds the supported size limit')
      }
      chunks.push(value)
    }
    const blob = new Blob(chunks, {
      type: response.headers.get('content-type') || 'application/octet-stream',
    })
    return await new Promise((resolve, reject) => {
      const fileReader = new FileReader()
      fileReader.onload = () => resolve(fileReader.result)
      fileReader.onerror = () =>
        reject(fileReader.error || new Error('Failed to encode image'))
      fileReader.readAsDataURL(blob)
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
  const directory = await mkdtemp(join(tmpdir(), TEMPORARY_IMAGE_DIRECTORY_PREFIX))
  const path = join(directory, temporaryImageFilename(image.filename, mimeType))
  try {
    await writeFile(path, bytes, { flag: 'wx' })
  } catch (error) {
    await rm(directory, { force: true, recursive: true })
    throw error
  }
  return path
}

function temporaryImageDirectory(path: string): string | null {
  const directory = resolve(dirname(path))
  if (dirname(directory) !== resolve(tmpdir())) return null
  return basename(directory).startsWith(TEMPORARY_IMAGE_DIRECTORY_PREFIX) ? directory : null
}

export function scheduleTemporaryImageCleanup(
  path: string,
  delayMs = TEMPORARY_IMAGE_CLEANUP_DELAY_MS
): void {
  const directory = temporaryImageDirectory(path)
  if (!directory) return

  const timer = setTimeout(() => {
    void rm(directory, { force: true, recursive: true }).catch(error => {
      console.error('[context-menu] failed to remove temporary image', error)
    })
  }, delayMs)
  timer.unref()
}

export async function cleanupStaleTemporaryImages(
  minimumAgeMs = STALE_TEMPORARY_IMAGE_AGE_MS,
  nowMs = Date.now()
): Promise<void> {
  const cutoff = nowMs - minimumAgeMs
  const entries = await readdir(tmpdir(), { withFileTypes: true })
  await Promise.all(
    entries
      .filter(
        entry => entry.isDirectory() && entry.name.startsWith(TEMPORARY_IMAGE_DIRECTORY_PREFIX)
      )
      .map(async entry => {
        const directory = join(tmpdir(), entry.name)
        const metadata = await stat(directory)
        if (metadata.mtimeMs > cutoff) return
        await rm(directory, { force: true, recursive: true })
      })
  )
}
