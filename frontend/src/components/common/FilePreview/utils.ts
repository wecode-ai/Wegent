// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type PreviewType =
  | 'image'
  | 'pdf'
  | 'text'
  | 'video'
  | 'audio'
  | 'office'
  | 'html'
  | 'unknown'

/**
 * Check if MIME type indicates an HTML file
 */
export function isHtmlMimeType(mimeType: string): boolean {
  return mimeType === 'text/html' || mimeType === 'application/xhtml+xml'
}

/**
 * Check if filename indicates an HTML file
 */
export function isHtmlFilename(filename: string): boolean {
  return /\.(html|htm|html5)$/i.test(filename)
}

/**
 * Check if file is an HTML file based on MIME type or filename
 */
export function isHtmlFile(mimeType: string, filename: string): boolean {
  return isHtmlMimeType(mimeType) || isHtmlFilename(filename)
}

/**
 * Check if file type is previewable
 * Centralized control for which file types support preview
 */
export function isFilePreviewable(mimeType: string, filename: string): boolean {
  // Image types
  if (mimeType.startsWith('image/')) return true
  // PDF
  if (mimeType === 'application/pdf') return true
  // Video
  if (mimeType.startsWith('video/')) return true
  // Audio
  if (mimeType.startsWith('audio/')) return true
  // HTML files
  if (isHtmlFile(mimeType, filename)) {
    return true
  }
  // Text files
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/xml' ||
    filename.match(
      /\.(txt|md|json|js|ts|jsx|tsx|py|java|go|rs|cpp|c|h|hpp|css|scss|less|xml|yaml|yml|sh|bash|zsh|ps1|sql|log)$/i
    )
  ) {
    return true
  }
  // Office documents (excluding PPT)
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/msword' ||
    mimeType === 'application/vnd.ms-excel' ||
    filename.match(/\.(xlsx|xls|csv|docx|doc)$/i)
  ) {
    return true
  }
  return false
}

/**
 * Determine preview type based on MIME type and filename
 */
export function getPreviewType(mimeType: string, filename: string): PreviewType {
  // First check if file is previewable at all
  if (!isFilePreviewable(mimeType, filename)) {
    return 'unknown'
  }

  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  // HTML files - render in preview mode
  if (isHtmlFile(mimeType, filename)) {
    return 'html'
  }
  // Text files
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/typescript' ||
    mimeType === 'application/xml' ||
    filename.match(
      /\.(txt|md|json|js|ts|jsx|tsx|py|java|go|rs|cpp|c|h|hpp|css|scss|less|xml|yaml|yml|sh|bash|zsh|ps1|sql|log)$/i
    )
  ) {
    return 'text'
  }
  // Office documents (Word/Excel only, PPT excluded)
  return 'office'
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes?: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * Get Office document type
 */
export function getOfficeType(filename: string): 'excel' | 'word' | 'powerpoint' {
  const ext = filename.toLowerCase()
  if (ext.match(/\.(xlsx|xls|csv)$/)) return 'excel'
  if (ext.match(/\.(pptx|ppt)$/)) return 'powerpoint'
  return 'word'
}

/**
 * Check if filename is a code file
 */
export function isCodeFile(filename: string): boolean {
  return /\.(js|ts|jsx|tsx|py|java|go|rs|cpp|c|h|hpp|css|scss|less|html|htm|xml|json|yaml|yml|sh|bash|zsh|ps1|sql)$/i.test(
    filename
  )
}

/**
 * Get Prism.js language identifier from filename
 */
export function getPrismLanguage(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || ''

  const languageMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'jsx',
    ts: 'typescript',
    tsx: 'tsx',
    py: 'python',
    java: 'java',
    go: 'go',
    rs: 'rust',
    cpp: 'cpp',
    c: 'c',
    h: 'c',
    hpp: 'cpp',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    xml: 'xml',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    ps1: 'powershell',
    sql: 'sql',
    md: 'markdown',
    txt: 'text',
    log: 'text',
  }

  return languageMap[ext] || 'text'
}
