export interface BoardReturnOrigin {
  scope: string
  store: 'local' | 'cloud'
  groupId: string
  threadId: string
  search: string
}

/** A board origin belongs to one visit to one exact Thread. */
export function retainBoardReturnOrigin(
  origin: BoardReturnOrigin | null,
  scope: string,
  search: string
): BoardReturnOrigin | null {
  if (!origin || origin.scope !== scope) return null
  const target = new URLSearchParams(search)
  return target.get('collaborationView') === 'groups' &&
    (target.get('groupStore') ?? 'local') === origin.store &&
    target.get('groupId') === origin.groupId &&
    target.get('threadId') === origin.threadId
    ? origin
    : null
}

/** Only explicit hierarchy navigation can carry a board origin to another Thread. */
export function nextBoardReturnOrigin(
  origin: BoardReturnOrigin | null,
  scope: string,
  currentSearch: string,
  nextSearch: string,
  relatedThreadId?: string
): BoardReturnOrigin | null {
  const current = retainBoardReturnOrigin(origin, scope, currentSearch)
  const target = new URLSearchParams(nextSearch)
  const threadId = target.get('threadId')
  if (
    current &&
    relatedThreadId === current.threadId &&
    threadId &&
    retainBoardReturnOrigin({ ...current, threadId }, scope, nextSearch)
  )
    return { ...current, threadId }
  return retainBoardReturnOrigin(current, scope, nextSearch)
}
