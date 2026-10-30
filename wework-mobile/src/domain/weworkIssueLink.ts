export interface WeworkIssueLink {
  projectId: string
  itemId: string
}

const APP_LINK_PATH = '/open-wework'
const APP_LINK_PARAMS = new Set(['projectId', 'itemId', 'commentId'])
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

function validProjectId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('?') &&
    !value.includes('#') &&
    !CONTROL_CHARACTERS.test(value)
  )
}

function validItemId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    value !== '.' &&
    value !== '..' &&
    !CONTROL_CHARACTERS.test(value)
  )
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function parseSchemeLink(url: URL): WeworkIssueLink | null {
  if (
    url.hostname !== 'boards' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return null
  }

  const segments = url.pathname.split('/').filter(Boolean)
  const hasCommentSuffix =
    segments.length === 5 && segments[1] === 'issues' && segments[3] === 'comments'
  if ((segments.length !== 3 && !hasCommentSuffix) || segments[1] !== 'issues') return null

  const projectId = decodeSegment(segments[0])
  const itemId = decodeSegment(segments[2])
  const commentId = hasCommentSuffix ? decodeSegment(segments[4]) : null
  if (!projectId || !itemId || (hasCommentSuffix && !commentId)) return null
  if (
    !validProjectId(projectId) ||
    !validItemId(itemId) ||
    (commentId !== null && !validItemId(commentId))
  ) {
    return null
  }

  return { projectId, itemId }
}

function parseAppLink(url: URL): WeworkIssueLink | null {
  if (url.pathname !== APP_LINK_PATH || url.username || url.password || url.hash) {
    return null
  }

  const seen = new Set<string>()
  for (const key of url.searchParams.keys()) {
    if (!APP_LINK_PARAMS.has(key) || seen.has(key)) return null
    seen.add(key)
  }

  const projectId = url.searchParams.get('projectId')
  const itemId = url.searchParams.get('itemId')
  const commentId = url.searchParams.get('commentId')
  if (!projectId || !/^[1-9]\d*$/.test(projectId)) return null
  if (!itemId || !validProjectId(projectId) || !validItemId(itemId)) return null
  if (commentId !== null && !validItemId(commentId)) return null

  return { projectId, itemId }
}

export function parseWeworkIssueLink(
  input: string,
  appLinkOrigins: readonly string[] = []
): WeworkIssueLink | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (['wework:', 'wegent:'].includes(url.protocol)) return parseSchemeLink(url)
  if (url.protocol !== 'https:' || !appLinkOrigins.includes(url.origin)) return null
  return parseAppLink(url)
}

export function weworkAppLinkOrigins(webUrl?: string): string[] {
  const origins = new Set<string>()
  if (webUrl) {
    try {
      const url = new URL(webUrl)
      if (['http:', 'https:'].includes(url.protocol)) origins.add(url.origin)
    } catch {
      // Ignore an invalid Backend-provided Web address.
    }
  }
  const configuredHost = process.env.EXPO_PUBLIC_WEWORK_APP_LINK_HOST?.trim()
  if (configuredHost) origins.add(`https://${configuredHost}`)
  return [...origins]
}

export function weworkWebOrigin(webUrl: string): string | null {
  try {
    const url = new URL(webUrl)
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : null
  } catch {
    return null
  }
}

export function weworkIssueWebUrl(webUrl: string, issue: WeworkIssueLink): string {
  return `${webUrl.replace(/\/+$/, '')}/collaboration/${encodeURIComponent(
    issue.projectId
  )}/issues/${encodeURIComponent(issue.itemId)}`
}

export function weworkIssueBootstrapUrl(
  webUrl: string,
  issue: WeworkIssueLink,
  accessToken: string
): string {
  const redirect = `/collaboration/${encodeURIComponent(issue.projectId)}/issues/${encodeURIComponent(
    issue.itemId
  )}`
  return `${webUrl.replace(/\/+$/, '')}/mobile-web-session#token=${encodeURIComponent(
    accessToken
  )}&redirect=${encodeURIComponent(redirect)}`
}

export function parseWeworkIssueWebUrl(input: string, webUrl: string): string | null {
  const issue = parseWeworkIssueLink(input)
  return issue ? weworkIssueWebUrl(webUrl, issue) : null
}
