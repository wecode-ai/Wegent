import { COLLABORATION_EXP_PATH } from '../collaborationExpFeature'

export type CollaborationExpQueryUpdate = Readonly<Record<string, string | null | undefined>>

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
