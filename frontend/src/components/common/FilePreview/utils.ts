// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type PreviewType = 'image' | 'pdf' | 'text' | 'video' | 'audio' | 'office' | 'unknown'

/**
 * Determine preview type based on MIME type and filename
 */
export function getPreviewType(mimeType: string, filename: string): PreviewType {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/typescript' ||
    mimeType === 'application/xml' ||
    filename.match(
      /\.(txt|md|json|js|ts|jsx|tsx|py|java|go|rs|cpp|c|h|hpp|css|scss|less|html|htm|xml|yaml|yml|sh|bash|zsh|ps1|sql|log)$/i
    )
  ) {
    return 'text'
  }
  if (
    mimeType.includes('officedocument') ||
    mimeType.includes('msword') ||
    mimeType.includes('ms-excel') ||
    mimeType.includes('ms-powerpoint') ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    filename.match(/\.(xlsx|xls|csv|docx|doc|pptx|ppt)$/i)
  ) {
    return 'office'
  }
  return 'unknown'
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
