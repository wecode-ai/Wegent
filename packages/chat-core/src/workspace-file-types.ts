import { normalizeWorkspaceSeparators } from './workspace-file-contract'
const MARKDOWN_FILE_PATTERN = /\.(?:md|markdown)$/i
const HTML_FILE_PATTERN = /\.(?:html?|xhtml)$/i

export type WorkspaceFilePreviewKind = 'text' | 'binary' | 'unknown'

const TEXT_FILE_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'cs',
  'css',
  'csv',
  'dart',
  'go',
  'h',
  'hpp',
  'htm',
  'html',
  'java',
  'js',
  'json',
  'ipynb',
  'tex',
  'jsx',
  'kt',
  'log',
  'md',
  'markdown',
  'mjs',
  'py',
  'rb',
  'rs',
  'sh',
  'sql',
  'svg',
  'toml',
  'ts',
  'tsx',
  'tsv',
  'txt',
  'xml',
  'yaml',
  'yml',
  'zsh',
])

const BINARY_FILE_EXTENSIONS = new Set([
  'avif',
  'xlsm',
  'mp4',
  'ogv',
  'webm',
  'bmp',
  'doc',
  'docx',
  'epub',
  'gif',
  'jpeg',
  'jpg',
  'mermaid',
  'mmd',
  'odp',
  'ods',
  'odt',
  'pdf',
  'plantuml',
  'png',
  'ppt',
  'pptx',
  'puml',
  'tif',
  'tiff',
  'webp',
  'xls',
  'xlsx',
  'xmind',
  'zip',
])

const TEXT_FILE_NAMES = new Set(['dockerfile', 'license', 'makefile', 'readme'])

function fileName(path: string): string {
  return normalizeWorkspaceSeparators(path).split('/').pop()?.toLowerCase() ?? ''
}

export function isMarkdownFile(path: string): boolean {
  return MARKDOWN_FILE_PATTERN.test(path)
}

export function isHtmlFile(path: string): boolean {
  return HTML_FILE_PATTERN.test(path)
}

export function isPreviewableTextFile(path: string): boolean {
  return isMarkdownFile(path) || isHtmlFile(path)
}

export function workspaceFilePreviewKind(path: string, contentType = ''): WorkspaceFilePreviewKind {
  const name = fileName(path)
  if (TEXT_FILE_NAMES.has(name) || name.startsWith('dockerfile.')) return 'text'

  const dotIndex = name.lastIndexOf('.')
  const extension = dotIndex >= 0 ? name.slice(dotIndex + 1) : ''
  if (TEXT_FILE_EXTENSIONS.has(extension)) return 'text'
  if (BINARY_FILE_EXTENSIONS.has(extension)) return 'binary'

  const normalizedContentType = contentType.toLowerCase()
  if (
    normalizedContentType.startsWith('text/') ||
    normalizedContentType.includes('json') ||
    normalizedContentType.includes('xml') ||
    normalizedContentType.includes('yaml') ||
    normalizedContentType.includes('javascript')
  ) {
    return 'text'
  }
  if (
    normalizedContentType.startsWith('image/') ||
    normalizedContentType === 'application/pdf' ||
    normalizedContentType === 'application/zip' ||
    normalizedContentType.includes('officedocument') ||
    normalizedContentType.includes('opendocument') ||
    normalizedContentType === 'application/msword' ||
    normalizedContentType === 'application/vnd.ms-excel' ||
    normalizedContentType === 'application/vnd.ms-powerpoint'
  ) {
    return 'binary'
  }
  return 'unknown'
}

export function isLikelyTextContent(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return true
  if (bytes.includes(0)) return false

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return false
  }

  let controlCharacters = 0
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0
    if (
      (codePoint >= 0 && codePoint <= 8) ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127
    ) {
      controlCharacters += 1
    }
  }
  return controlCharacters / Math.max(text.length, 1) <= 0.01
}

export function mimeTypeForFileName(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase()
  const types: Record<string, string> = {
    csv: 'text/csv',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    gif: 'image/gif',
    htm: 'text/html',
    html: 'text/html',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    mp4: 'video/mp4',
    ogv: 'video/ogg',
    pdf: 'application/pdf',
    png: 'image/png',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    webp: 'image/webp',
    webm: 'video/webm',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
  return types[extension ?? ''] ?? 'application/octet-stream'
}

const FILE_VIEWER_TYPE_BY_MIME: Record<string, string> = {
  'application/epub+zip': 'epub',
  'application/msword': 'doc',
  'application/pdf': 'pdf',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/zip': 'zip',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/webp': 'webp',
  'text/csv': 'csv',
}

const DIAGRAM_FILE_VIEWER_TYPE_BY_EXTENSION: Record<string, string> = {
  mermaid: 'mermaid',
  mmd: 'mermaid',
  plantuml: 'plantuml',
  puml: 'plantuml',
}

export function workspaceFileViewerType(name: string, mimeType: string): string | undefined {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  return (
    ({ csv: 'csv', tsv: 'csv', xlsm: 'xlsx' } as Record<string, string>)[extension] ??
    DIAGRAM_FILE_VIEWER_TYPE_BY_EXTENSION[extension] ??
    FILE_VIEWER_TYPE_BY_MIME[mimeType.split(';', 1)[0].trim().toLowerCase()]
  )
}
