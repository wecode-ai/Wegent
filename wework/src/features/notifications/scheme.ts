export type WeworkDestination =
  | { kind: 'boards' }
  | {
      kind: 'group'
      groupStore: 'local' | 'backend'
      groupId: string
      threadId?: string
      commentId?: string
    }
  | {
      kind: 'board'
      projectId: string
      projectStore?: 'local' | 'backend'
      itemId?: string
      commentId?: string
    }
  | { kind: 'task'; deviceId: string; taskId: string }
  | { kind: 'interaction'; deviceId: string; taskId: string; requestKey: string }
  | { kind: 'app'; appId: string }
  | { kind: 'smart-app'; smartAppId: number }

export function weworkInteractionScheme(
  address: { deviceId: string; taskId: string },
  requestKey: string
): string {
  return `wework://interactions/${encodeURIComponent(address.deviceId)}/${encodeURIComponent(address.taskId)}/${encodeURIComponent(requestKey)}`
}

export function weworkTaskScheme(address: { deviceId: string; taskId: string }): string {
  return `wework://tasks/${encodeURIComponent(address.deviceId)}/${encodeURIComponent(address.taskId)}`
}

export function weworkIssueScheme(
  projectId: string,
  itemId: string,
  projectStore: 'local' | 'backend' = 'backend'
): string {
  const storePrefix = projectStore === 'local' ? 'local/' : ''
  return `wework://boards/${storePrefix}${encodeURIComponent(projectId)}/issues/${encodeURIComponent(itemId)}`
}

export function weworkAppScheme(appId: string): string {
  return `wework://apps/${encodeURIComponent(appId)}`
}

export function weworkThreadScheme(
  groupId: string,
  threadId: string,
  groupStore: 'local' | 'backend' = 'backend',
  commentId?: string
): string {
  const base = `wework://groups/${groupStore}/${encodeURIComponent(groupId)}/threads/${encodeURIComponent(threadId)}`
  return commentId ? `${base}/comments/${encodeURIComponent(commentId)}` : base
}

export function weworkSmartAppScheme(smartAppId: number): string {
  if (!Number.isSafeInteger(smartAppId) || smartAppId <= 0) {
    throw new Error('Smart app id must be a positive safe integer')
  }
  return `wework://smart-apps/${smartAppId}`
}

function segment(value: string, limit = 128): string | null {
  const decoded = decodeURIComponent(value)
  return decoded &&
    decoded.length <= limit &&
    !Array.from(decoded).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    ? decoded
    : null
}

export function parseWeworkScheme(input: string): WeworkDestination | null {
  try {
    if (
      !input.startsWith('wework://') ||
      input !== input.trim() ||
      input.includes('?') ||
      input.includes('#') ||
      Array.from(input).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      input.split('/').some(part => ['.', '..'].includes(decodeURIComponent(part)))
    )
      return null
    const url = new URL(input)
    if (
      url.protocol !== 'wework:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      return null
    if (url.hostname === 'boards' && ['', '/'].includes(url.pathname)) return { kind: 'boards' }
    const parts = url.pathname.split('/').slice(1)
    if (url.hostname === 'groups' && [2, 4, 6].includes(parts.length)) {
      const groupStore = parts[0]
      const groupId = segment(parts[1])
      if (
        !['local', 'backend'].includes(groupStore) ||
        !groupId ||
        (groupStore === 'backend' && !/^[1-9]\d*$/.test(groupId))
      )
        return null
      const group = {
        kind: 'group' as const,
        groupStore: groupStore as 'local' | 'backend',
        groupId,
      }
      if (parts.length === 2) return group
      if (parts.length === 4 && parts[2] === 'comments') {
        const commentId = segment(parts[3])
        return commentId ? { ...group, commentId } : null
      }
      const threadId = segment(parts[3])
      if (parts[2] !== 'threads' || !threadId) return null
      if (parts.length === 4) return { ...group, threadId }
      const commentId = segment(parts[5])
      return parts[4] === 'comments' && commentId ? { ...group, threadId, commentId } : null
    }
    if (url.hostname === 'interactions' && parts.length === 3) {
      const deviceId = segment(parts[0])
      const taskId = segment(parts[1])
      const requestKey = segment(parts[2], 2048)
      return deviceId && taskId && requestKey
        ? { kind: 'interaction', deviceId, taskId, requestKey }
        : null
    }
    const localBoard = url.hostname === 'boards' && parts[0] === 'local'
    if (localBoard) parts.shift()
    const store = localBoard ? { projectStore: 'local' as const } : {}
    if (
      url.hostname === 'boards' &&
      (parts.length === 1 || parts.length === 3 || parts.length === 5)
    ) {
      const projectId = segment(parts[0])
      if (!projectId || (!localBoard && !/^[1-9]\d*$/.test(projectId))) return null
      if (parts.length === 1) return { kind: 'board', projectId, ...store }
      const itemId = segment(parts[2])
      if (parts[1] !== 'issues' || !itemId) return null
      if (parts.length === 3) return { kind: 'board', projectId, itemId, ...store }
      const commentId = segment(parts[4])
      return parts[3] === 'comments' && commentId
        ? { kind: 'board', projectId, itemId, commentId, ...store }
        : null
    }
    if (url.hostname === 'tasks' && parts.length === 2) {
      const deviceId = segment(parts[0])
      const taskId = segment(parts[1])
      return deviceId && taskId ? { kind: 'task', deviceId, taskId } : null
    }
    if (url.hostname === 'apps' && parts.length === 1) {
      const appId = segment(parts[0])
      return appId ? { kind: 'app', appId } : null
    }
    if (url.hostname === 'smart-apps' && parts.length === 1) {
      const smartAppSegment = segment(parts[0])
      if (!smartAppSegment || !/^[1-9]\d{0,15}$/.test(smartAppSegment)) return null
      const smartAppId = Number(smartAppSegment)
      return Number.isSafeInteger(smartAppId) ? { kind: 'smart-app', smartAppId } : null
    }
    return null
  } catch {
    return null
  }
}

export function weworkDestinationRoute(
  destination: WeworkDestination,
  focusRequest?: string
): string {
  if (destination.kind === 'boards') return '/todo'
  if (destination.kind === 'group') {
    const params = new URLSearchParams({
      collaborationView: 'groups',
      groupStore: destination.groupStore === 'backend' ? 'cloud' : 'local',
      groupId: destination.groupId,
      groupTab: 'chat',
    })
    if (destination.threadId) params.set('threadId', destination.threadId)
    if (destination.commentId) params.set('commentId', destination.commentId)
    if ((destination.threadId || destination.commentId) && focusRequest)
      params.set('focusRequest', focusRequest)
    return `/todo?${params}`
  }
  if (destination.kind === 'interaction') {
    return `/pending-interactions?${new URLSearchParams({ interaction: JSON.stringify([destination.deviceId, destination.taskId, destination.requestKey]) })}`
  }
  if (destination.kind === 'task') {
    const standIn = /^stand-in-chat-(\d+)-(primary|role-(.+))$/.exec(destination.taskId)
    if (standIn)
      return `/stand-in?${new URLSearchParams({
        deviceId: destination.deviceId,
        userId: standIn[1],
        profileId: standIn[2] === 'primary' ? '@primary' : standIn[3],
      })}`
    return `/runtime-tasks?${new URLSearchParams({ deviceId: destination.deviceId, taskId: destination.taskId })}`
  }
  if (destination.kind === 'smart-app') {
    return `/sites?${new URLSearchParams({
      app_type: 'smart_app',
      smartAppId: String(destination.smartAppId),
    })}`
  }
  if (destination.kind === 'app') {
    return `/app/${encodeURIComponent(destination.appId)}`
  }
  const params = new URLSearchParams({
    projectStore: destination.projectStore ?? 'backend',
    projectId: destination.projectId,
  })
  if (destination.itemId) params.set('itemId', destination.itemId)
  if (destination.commentId) {
    params.set('commentId', destination.commentId)
  }
  if (destination.itemId && focusRequest) params.set('focusRequest', focusRequest)
  return `/todo?${params}`
}
