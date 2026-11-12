const ISSUE_MENTION_SCHEME = 'wework-issue://'

export interface IssueMentionAddress {
  projectId: string
  issueId: string
}

/** Parses a `wework-issue://` mention into its project and Issue ids. */
export function parseIssueMentionHref(href: string): IssueMentionAddress | null {
  if (!href.startsWith(ISSUE_MENTION_SCHEME)) return null
  const [projectId, issueId] = href
    .slice(ISSUE_MENTION_SCHEME.length)
    .split('/')
    .map(decodePathSegment)
  return projectId && issueId ? { projectId, issueId } : null
}

/** Builds the board route that selects a referenced Issue. */
export function buildIssueMentionRoute(
  address: IssueMentionAddress,
  projectStore: 'local' | 'backend' = 'backend'
): string {
  const params = new URLSearchParams()
  params.set('projectStore', projectStore)
  params.set('projectId', address.projectId)
  params.set('itemId', address.issueId)
  return `/todo?${params.toString()}`
}

/** Resolves whether the referenced Issue belongs to the local or cloud board. */
export function issueMentionProjectStore(
  address: IssueMentionAddress,
  activeRoute: string
): 'local' | 'backend' {
  const searchIndex = activeRoute.indexOf('?')
  if (searchIndex < 0) return 'backend'
  const params = new URLSearchParams(activeRoute.slice(searchIndex + 1))
  return params.get('projectStore') === 'local' && params.get('projectId') === address.projectId
    ? 'local'
    : 'backend'
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return ''
  }
}
