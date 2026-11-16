// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface WeworkHandoffDestination {
  weworkUrl: string
  webPath?: string
}

const ALLOWED_PARAMS = new Set(['projectId', 'itemId', 'commentId', 'url'])
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const MAX_WEWORK_URL_LENGTH = 2048

function validSegment(value: string | null, limit = 128): value is string {
  return (
    value !== null &&
    value.length > 0 &&
    value.length <= limit &&
    value !== '.' &&
    value !== '..' &&
    !CONTROL_CHARACTERS.test(value)
  )
}

function decodeSegment(value: string, limit = 128): string | null {
  try {
    const decoded = decodeURIComponent(value)
    return validSegment(decoded, limit) ? decoded : null
  } catch {
    return null
  }
}

function hasDotSegment(raw: string): boolean {
  const pathStart = raw.indexOf('/', 'wework://'.length)
  if (pathStart < 0) return false
  return raw
    .slice(pathStart)
    .split('/')
    .slice(1)
    .some(part => {
      try {
        const decoded = decodeURIComponent(part)
        return decoded === '.' || decoded === '..'
      } catch {
        return true
      }
    })
}

function parseWeworkDeepLink(raw: string): WeworkHandoffDestination | null {
  if (
    !raw.startsWith('wework://') ||
    raw !== raw.trim() ||
    raw.length > MAX_WEWORK_URL_LENGTH ||
    CONTROL_CHARACTERS.test(raw) ||
    raw.includes('?') ||
    raw.includes('#')
  ) {
    return null
  }
  if (hasDotSegment(raw)) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'wework:' || url.username || url.password || url.port) return null
    const parts = url.pathname.split('/').slice(1)
    if (parts.some(part => ['.', '..'].includes(part))) return null
    if (url.hostname === 'boards' && ['', '/'].includes(url.pathname)) {
      return { weworkUrl: raw, webPath: '/collaboration' }
    }
    const localBoard = url.hostname === 'boards' && parts[0] === 'local'
    if (localBoard) parts.shift()
    if (
      url.hostname === 'boards' &&
      (parts.length === 1 || parts.length === 3 || parts.length === 5)
    ) {
      const projectId = decodeSegment(parts[0] ?? '')
      if (!projectId || (!localBoard && !/^[1-9]\d*$/.test(projectId))) return null
      const itemId = parts.length === 1 ? null : decodeSegment(parts[2] ?? '')
      if (parts.length > 1 && (parts[1] !== 'issues' || !itemId)) return null
      const commentId = parts.length === 5 ? decodeSegment(parts[4] ?? '') : null
      if (parts.length === 5 && (parts[3] !== 'comments' || !commentId)) return null
      const projectPath = `/collaboration/${encodeURIComponent(projectId)}`
      const itemPath = itemId ? `/issues/${encodeURIComponent(itemId)}` : ''
      return {
        weworkUrl: raw,
        webPath:
          localBoard || !itemId
            ? localBoard
              ? undefined
              : projectPath
            : `${projectPath}${itemPath}`,
      }
    }
    if (
      url.hostname === 'tasks' &&
      parts.length === 2 &&
      decodeSegment(parts[0] ?? '') &&
      decodeSegment(parts[1] ?? '')
    ) {
      return { weworkUrl: raw }
    }
    if (
      url.hostname === 'interactions' &&
      parts.length === 3 &&
      decodeSegment(parts[0] ?? '') &&
      decodeSegment(parts[1] ?? '') &&
      decodeSegment(parts[2] ?? '', MAX_WEWORK_URL_LENGTH)
    ) {
      return { weworkUrl: raw }
    }
    if (url.hostname === 'apps' && parts.length === 1 && decodeSegment(parts[0] ?? '')) {
      return { weworkUrl: raw }
    }
    if (
      url.hostname === 'smart-apps' &&
      parts.length === 1 &&
      /^[1-9]\d{0,15}$/.test(parts[0] ?? '') &&
      Number.isSafeInteger(Number(parts[0]))
    ) {
      return { weworkUrl: raw }
    }
    return null
  } catch {
    return null
  }
}

export function parseWeworkHandoff(params: URLSearchParams): WeworkHandoffDestination | null {
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key) || params.getAll(key).length !== 1) return null
  }
  const rawUrl = params.get('url')
  if (rawUrl !== null) {
    return Array.from(params.keys()).length === 1 ? parseWeworkDeepLink(rawUrl) : null
  }

  const projectId = params.get('projectId')
  const itemId = params.get('itemId')
  const commentId = params.get('commentId')
  if (!projectId || projectId.length > 128 || !/^[1-9]\d*$/.test(projectId)) return null
  if (itemId !== null && !validSegment(itemId)) return null
  if (commentId !== null && (itemId === null || !validSegment(commentId))) return null

  const projectPath = `/collaboration/${projectId}`
  const itemPath = itemId === null ? '' : `/issues/${encodeURIComponent(itemId)}`
  const commentPath = commentId === null ? '' : `/comments/${encodeURIComponent(commentId)}`
  return {
    weworkUrl: `wework://boards/${projectId}${itemPath}${commentPath}`,
    webPath: `${projectPath}${itemPath}`,
  }
}
