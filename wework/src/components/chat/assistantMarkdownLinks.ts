import { isElectronRuntime } from '@/lib/runtime-environment'
import { isWindowsDriveAbsolutePath } from '@/lib/workspace-paths'

const ATTACHMENT_DOWNLOAD_PATH_PATTERN = /\/(?:api\/)?attachments\/(\d+)\/download(?:[?#].*)?$/

export type MarkdownLinkTarget =
  | { kind: 'external' }
  | { kind: 'internal'; path: string }
  | { kind: 'none' }
  | {
      kind: 'file'
      path: string
      lineStart?: number
      lineEnd?: number
      isDirectory?: boolean
    }

export interface ExtractedMarkdownLink {
  href: string
  title: string
}

const HTML_FILE_PATTERN = /\.(?:html?|xhtml)$/i
const MARKDOWN_ESCAPED_PUNCTUATION_PATTERN = /\\([!-/:-@[-`{-~])/g
// Protected Markdown links may be encoded again by intermediate URL normalizers.
const MAX_MARKDOWN_FILE_PATH_DECODE_PASSES = 16

export function decodeMarkdownFilePath(path: string): string {
  let decodedPath = path
  for (let pass = 0; pass < MAX_MARKDOWN_FILE_PATH_DECODE_PASSES; pass += 1) {
    try {
      const nextPath = decodeURIComponent(decodedPath)
      if (nextPath === decodedPath) return decodedPath
      decodedPath = nextPath
    } catch {
      return decodedPath
    }
  }
  return decodedPath
}

export function extractMarkdownLinks(content: string): ExtractedMarkdownLink[] {
  const links: ExtractedMarkdownLink[] = []
  let cursor = 0

  while (cursor < content.length) {
    const labelStart = content.indexOf('[', cursor)
    if (labelStart < 0) break
    const labelEnd = content.indexOf('](', labelStart + 1)
    if (labelEnd < 0) break

    const destination = parseMarkdownLinkDestination(content, labelEnd + 2)
    if (destination) {
      const title = content.slice(labelStart + 1, labelEnd).trim()
      if (title) links.push({ href: destination.href, title })
      cursor = destination.end
      continue
    }
    cursor = labelStart + 1
  }

  return links
}

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
  const environmentSettings = value.match(
    /^\/projects\/([^/?#]+)\/settings\/environment-variables(?:[?#].*)?$/
  )
  if (environmentSettings) {
    const params = new URLSearchParams({
      app_type: 'web',
      view: 'environment-variables',
      project_id: decodeMarkdownFilePath(environmentSettings[1]),
    })
    return { kind: 'internal', path: `/sites?${params.toString()}` }
  }
  if (/^(https?|mailto|tel):/i.test(value)) return { kind: 'external' }
  if (value.startsWith('#')) return { kind: 'none' }
  if (value.startsWith('folder://')) {
    try {
      return {
        kind: 'file',
        path: decodeMarkdownFilePath(value.slice('folder://'.length)),
        isDirectory: true,
      }
    } catch {
      return { kind: 'none' }
    }
  }
  if (value.startsWith('file://')) {
    return { kind: 'file', ...splitMarkdownFileLineSuffix(localPathFromMarkdownImageSrc(value)) }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !isWindowsDriveAbsolutePath(value)) {
    return { kind: 'external' }
  }
  return {
    kind: 'file',
    ...splitMarkdownFileLineSuffix(decodeMarkdownFilePath(value)),
  }
}

export function isHtmlFilePath(path: string): boolean {
  return HTML_FILE_PATTERN.test(path.split(/[?#]/, 1)[0])
}

export function localHtmlBrowserUrl(path: string): string | null {
  if (!isHtmlFilePath(path)) return null
  return isElectronRuntime() ? desktopFileUrl(path) : null
}

export function desktopFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const encoded = normalized
    .split('/')
    .map(segment => encodeURIComponent(segment).replace(/%3A/gi, ':'))
    .join('/')
  return `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`
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
  const localPath = localMarkdownImagePath(src)
  if (!localPath) return src

  return isElectronRuntime() ? desktopFileUrl(localPath) : null
}

export function localMarkdownImagePath(src: string): string | null {
  return isLocalImagePath(src) ? localPathFromMarkdownImageSrc(src) : null
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

export function getAuthenticatedAttachmentId(src: string): number | null {
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
  return getAuthenticatedAttachmentId(src) !== null
}

function isLocalImagePath(src: string): boolean {
  if (src.startsWith('file://')) return true
  if (isWindowsDriveAbsolutePath(src)) return true

  return src.startsWith('/') && !isAuthenticatedAttachmentImageSrc(src)
}

function parseMarkdownLinkDestination(
  content: string,
  start: number
): { href: string; end: number } | null {
  if (content[start] === '<') {
    const destinationEnd = content.indexOf('>', start + 1)
    if (destinationEnd < 0) return null
    const href = decodeMarkdownDestinationEscapes(content.slice(start + 1, destinationEnd).trim())
    const linkEnd = markdownLinkEnd(content, destinationEnd + 1)
    return href && linkEnd !== null ? { href, end: linkEnd } : null
  }

  let cursor = start
  let depth = 0
  let escaped = false
  while (cursor < content.length) {
    const character = content[cursor]
    if (escaped) {
      escaped = false
      cursor += 1
      continue
    }
    if (character === '\\') {
      escaped = true
      cursor += 1
      continue
    }
    if (character === '(') {
      depth += 1
    } else if (character === ')') {
      if (depth === 0) break
      depth -= 1
    } else if (/\s/.test(character) && depth === 0) {
      break
    }
    cursor += 1
  }

  const href = decodeMarkdownDestinationEscapes(content.slice(start, cursor).trim())
  const linkEnd = markdownLinkEnd(content, cursor)
  return href && depth === 0 && linkEnd !== null ? { href, end: linkEnd } : null
}

function decodeMarkdownDestinationEscapes(destination: string): string {
  return destination.replace(MARKDOWN_ESCAPED_PUNCTUATION_PATTERN, '$1')
}

function markdownLinkEnd(content: string, start: number): number | null {
  let cursor = start
  while (/\s/.test(content[cursor] ?? '')) cursor += 1

  const quote = content[cursor]
  if (quote === '"' || quote === "'") {
    cursor += 1
    while (cursor < content.length && content[cursor] !== quote) cursor += 1
    if (content[cursor] !== quote) return null
    cursor += 1
    while (/\s/.test(content[cursor] ?? '')) cursor += 1
  }

  return content[cursor] === ')' ? cursor + 1 : null
}
