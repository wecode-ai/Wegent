import { convertFileSrc } from '@tauri-apps/api/core'
import { getAttachmentImageUrl } from '@/lib/attachments'

const ATTACHMENT_DOWNLOAD_PATH_PATTERN = /\/(?:api\/)?attachments\/(\d+)\/download(?:[?#].*)?$/

export type MarkdownLinkTarget =
  | { kind: 'external' }
  | { kind: 'none' }
  | { kind: 'file'; path: string; lineStart?: number; lineEnd?: number }

const HTML_FILE_PATTERN = /\.(?:html?|xhtml)$/i
const LOCAL_TAURI_PATH_PREFIXES = ['/Users/', '/Volumes/', '/private/', '/tmp/', '/var/']

// Assistant responses frequently reference repository files with relative or
// absolute filesystem paths. Rendering those as plain anchors makes the browser
// navigate the SPA to a broken `http://localhost/...` URL, so file links are
// routed to the caller instead.
export function classifyMarkdownLink(href?: string): MarkdownLinkTarget {
  const trimmedHref = href?.trim()
  const value =
    trimmedHref?.startsWith('<') && trimmedHref.endsWith('>')
      ? trimmedHref.slice(1, -1).trim()
      : trimmedHref
  if (!value) return { kind: 'none' }
  if (/^(https?|mailto|tel):/i.test(value)) return { kind: 'external' }
  if (value.startsWith('#')) return { kind: 'none' }
  const localTauriPath = localPathFromTauriUrl(value)
  if (localTauriPath) {
    return { kind: 'file', ...splitMarkdownFileLineSuffix(localTauriPath) }
  }
  if (value.startsWith('file://')) {
    return { kind: 'file', ...splitMarkdownFileLineSuffix(localPathFromMarkdownImageSrc(value)) }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return { kind: 'external' }
  return { kind: 'file', ...splitMarkdownFileLineSuffix(value) }
}

export function isHtmlFilePath(path: string): boolean {
  return HTML_FILE_PATTERN.test(path.split(/[?#]/, 1)[0])
}

export function localHtmlBrowserUrl(path: string): string | null {
  if (!isHtmlFilePath(path) || typeof convertFileSrc !== 'function') return null

  try {
    return convertFileSrc(path)
  } catch {
    return null
  }
}

export function splitMarkdownFileLineSuffix(path: string): {
  path: string
  lineStart?: number
  lineEnd?: number
} {
  const match = path.match(/^(.*?):(\d+)(?:-(\d+))?$/)
  if (!match) return { path }

  const basePath = match[1]
  if (!basePath || /^[a-zA-Z]$/.test(basePath)) return { path }

  const lineStart = Number(match[2])
  const lineEnd = match[3] ? Number(match[3]) : undefined
  return {
    path: basePath,
    lineStart: Number.isFinite(lineStart) ? lineStart : undefined,
    lineEnd: lineEnd && Number.isFinite(lineEnd) ? lineEnd : undefined,
  }
}

export function resolveDirectMarkdownImageSrc(src: string): string | null {
  if (!isLocalImagePath(src)) return src

  const localPath = localPathFromMarkdownImageSrc(src)
  if (typeof convertFileSrc !== 'function') return null

  try {
    return convertFileSrc(localPath)
  } catch {
    return null
  }
}

export function localPathFromMarkdownImageSrc(src: string): string {
  if (!src.startsWith('file://')) return src

  try {
    const pathname = decodeURIComponent(new URL(src).pathname)
    return pathname.match(/^\/[a-zA-Z]:\//) ? pathname.slice(1) : pathname
  } catch {
    return src
  }
}

function localPathFromTauriUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'tauri:' || url.hostname !== 'localhost') return null

    const pathname = decodeURIComponent(url.pathname)
    if (LOCAL_TAURI_PATH_PREFIXES.some(prefix => pathname.startsWith(prefix))) {
      return pathname
    }
    return /^\/[a-zA-Z]:\//.test(pathname) ? pathname.slice(1) : null
  } catch {
    return null
  }
}

function getAttachmentDownloadId(src: string): number | null {
  try {
    const url = new URL(src)
    const match = url.pathname.match(ATTACHMENT_DOWNLOAD_PATH_PATTERN)
    return match ? Number(match[1]) : null
  } catch {
    const match = src.match(ATTACHMENT_DOWNLOAD_PATH_PATTERN)
    return match ? Number(match[1]) : null
  }
}

export function isAuthenticatedAttachmentImageSrc(src: string): boolean {
  return getAttachmentDownloadId(src) !== null
}

export function getAuthenticatedImageFetchUrl(src: string): string {
  if (src.startsWith('/api/')) return src
  if (/^https?:\/\//i.test(src)) return src

  const attachmentId = getAttachmentDownloadId(src)
  return attachmentId === null ? src : getAttachmentImageUrl(attachmentId)
}

function isLocalImagePath(src: string): boolean {
  if (src.startsWith('file://')) return true
  if (/^[a-zA-Z]:[\\/]/.test(src)) return true

  return src.startsWith('/') && !isAuthenticatedAttachmentImageSrc(src)
}
