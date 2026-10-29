export interface WeworkIssueLink {
  projectId: string
  itemId: string
}

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

export function parseWeworkIssueLink(input: string): WeworkIssueLink | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (!['wework:', 'wegent:'].includes(url.protocol)) return null
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
  if (segments.length !== 3 || segments[1] !== 'issues') return null

  const projectId = decodeSegment(segments[0])
  const itemId = decodeSegment(segments[2])
  if (!projectId || !itemId) return null
  if (!validProjectId(projectId) || !validItemId(itemId)) return null

  return { projectId, itemId }
}

export function weworkIssueWebUrl(webUrl: string, issue: WeworkIssueLink): string {
  return `${webUrl.replace(/\/+$/, '')}/collaboration/${encodeURIComponent(
    issue.projectId
  )}/issues/${encodeURIComponent(issue.itemId)}`
}

export function parseWeworkIssueWebUrl(input: string, webUrl: string): string | null {
  const issue = parseWeworkIssueLink(input)
  return issue ? weworkIssueWebUrl(webUrl, issue) : null
}
