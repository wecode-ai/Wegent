const MARKDOWN_FILE_PATTERN = /\.(?:md|markdown)$/i

export type WorkspaceFilePreviewKind = 'text' | 'binary' | 'unknown'

const TEXT_FILE_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'cs',
  'css',
  'dart',
  'go',
  'h',
  'hpp',
  'htm',
  'html',
  'java',
  'js',
  'json',
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
  'txt',
  'xml',
  'yaml',
  'yml',
  'zsh',
])

const BINARY_FILE_EXTENSIONS = new Set([
  'avif',
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
  return path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
}

export function isMarkdownFile(path: string): boolean {
  return MARKDOWN_FILE_PATTERN.test(path)
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
