import { COLLABORATION_EXP_PATH } from '../collaborationExpFeature'

export type CollaborationExpQueryUpdate = Readonly<Record<string, string | null | undefined>>

const assistantContextKeys = [
  'assistantDeviceId',
  'assistantTaskId',
  'deviceId',
  'profileId',
  'settingsRequest',
  'userId',
]

function isLegacyAssistantLink(params: URLSearchParams): boolean {
  const view = params.get('view')
  if (view === 'assistant') return true
  if (view === 'tasks') return false
  const hasCollaborationContext = [
    'taskMode',
    'projectId',
    'projectScope',
    'projectView',
    'issueId',
    'discussion',
    'nodeId',
    'commentId',
  ].some(key => params.has(key))
  return !hasCollaborationContext && assistantContextKeys.some(key => params.has(key))
}

function legacyAssistantParams(contentRoute: string): URLSearchParams | null {
  if (!contentRoute.startsWith(`${COLLABORATION_EXP_PATH}?`)) return null
  const params = new URLSearchParams(contentRoute.slice(COLLABORATION_EXP_PATH.length + 1))
  return isLegacyAssistantLink(params) ? params : null
}

export function canonicalAssistantRoute(contentRoute: string): string {
  const params = legacyAssistantParams(contentRoute)
  if (!params) return contentRoute
  // Release the collaboration tab identity and retain the assistant address.
  for (const key of ['view', 'workspaceTab', 'workspaceTabTitle']) params.delete(key)
  return params.size ? `/stand-in?${params}` : '/stand-in'
}

export function restoreCollaborationTabRoute(contentRoute: string): string {
  const params = legacyAssistantParams(contentRoute)
  if (!params) return contentRoute
  for (const key of ['view', ...assistantContextKeys]) params.delete(key)
  return buildCollaborationExpRoute(params)
}

export function buildCollaborationExpRoute(
  search: string | URLSearchParams = '',
  updates: CollaborationExpQueryUpdate = {}
): string {
  const params = new URLSearchParams(search)
  for (const [key, value] of Object.entries(updates)) {
    if (value == null) params.delete(key)
    else params.set(key, value)
  }
  const query = params.toString()
  return `${COLLABORATION_EXP_PATH}${query ? `?${query}` : ''}`
}

export function buildCollaborationExpScheme(
  search: string | URLSearchParams = '',
  updates: CollaborationExpQueryUpdate = {}
): string {
  return `wework://collaboration-exp${buildCollaborationExpRoute(search, updates).slice(COLLABORATION_EXP_PATH.length)}`
}

export function parseCollaborationExpDeepLink(input: string): string | null {
  if (
    input !== input.trim() ||
    input.includes('#') ||
    Array.from(input).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return null
  try {
    const url = new URL(input, 'https://wework.invalid')
    const internal =
      input.startsWith('/') && !input.startsWith('//') && url.pathname === COLLABORATION_EXP_PATH
    const scheme =
      input.startsWith('wework://') &&
      url.protocol === 'wework:' &&
      url.hostname === 'collaboration-exp' &&
      ['', '/'].includes(url.pathname)
    if ((!internal && !scheme) || url.username || url.password || url.port || url.hash) return null
    const projectStore = url.searchParams.get('projectStore')
    if (projectStore !== null && projectStore !== 'local' && projectStore !== 'backend') return null
    return buildCollaborationExpRoute(url.searchParams)
  } catch {
    return null
  }
}
