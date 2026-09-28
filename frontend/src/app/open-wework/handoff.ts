// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface WeworkHandoffDestination {
  weworkUrl: string
  webPath: string
}

const ALLOWED_PARAMS = new Set(['projectId', 'itemId', 'commentId'])
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

function validSegment(value: string | null): value is string {
  return (
    value !== null &&
    value.length > 0 &&
    value.length <= 128 &&
    value !== '.' &&
    value !== '..' &&
    !CONTROL_CHARACTERS.test(value)
  )
}

export function parseWeworkHandoff(params: URLSearchParams): WeworkHandoffDestination | null {
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key) || params.getAll(key).length !== 1) return null
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
