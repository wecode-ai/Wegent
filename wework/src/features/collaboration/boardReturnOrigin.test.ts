import { describe, expect, it } from 'vitest'
import {
  nextBoardReturnOrigin,
  retainBoardReturnOrigin,
  type BoardReturnOrigin,
} from './boardReturnOrigin'

const origin: BoardReturnOrigin = {
  scope: 'backend:account-7',
  store: 'cloud',
  groupId: 'shared-id',
  threadId: 'thread-1',
  search: '?collaborationView=projects&projectId=project-1&view=table&search=review',
}
const thread = '?collaborationView=groups&groupStore=cloud&groupId=shared-id&threadId=thread-1'

describe('the originating board of a Thread visit', () => {
  it('keeps the original search and selected view during same-Thread comment focus updates', () => {
    const current = retainBoardReturnOrigin(
      origin,
      origin.scope,
      `${thread}&commentId=message-2&focusRequest=next`
    )
    expect(current).toBe(origin)
    expect(current?.search).toBe(origin.search)
  })

  it('does not attach an old board when a Thread is opened directly after returning', () => {
    const afterReturning = retainBoardReturnOrigin(origin, origin.scope, origin.search)
    expect(afterReturning).toBeNull()
    expect(retainBoardReturnOrigin(afterReturning, origin.scope, thread)).toBeNull()
  })

  it('clears the visit when another Thread is opened in the same group', () => {
    const nextThread = thread.replace('thread-1', 'thread-2')
    const afterDirectNavigation = retainBoardReturnOrigin(origin, origin.scope, nextThread)
    expect(afterDirectNavigation).toBeNull()
    expect(retainBoardReturnOrigin(afterDirectNavigation, origin.scope, thread)).toBeNull()
  })

  it('does not confuse identical group IDs across stores or accounts', () => {
    expect(
      retainBoardReturnOrigin(origin, origin.scope, thread.replace('cloud', 'local'))
    ).toBeNull()
    expect(retainBoardReturnOrigin(origin, 'backend:account-8', thread)).toBeNull()
  })

  it('keeps the exact originating board when explicitly opening a child or parent Thread', () => {
    const child = thread.replace('thread-1', 'thread-2')
    const next = nextBoardReturnOrigin(origin, origin.scope, thread, child, origin.threadId)
    expect(next).toEqual({ ...origin, threadId: 'thread-2' })
    expect(nextBoardReturnOrigin(next, origin.scope, child, thread, 'thread-2')).toEqual(origin)
    expect(nextBoardReturnOrigin(origin, origin.scope, thread, child)).toBeNull()
  })

  it('never revives a stale board through a hierarchy callback after leaving its visit', () => {
    expect(
      nextBoardReturnOrigin(origin, origin.scope, origin.search, thread, origin.threadId)
    ).toBeNull()
    expect(
      nextBoardReturnOrigin(
        origin,
        origin.scope,
        thread,
        thread.replace('cloud', 'local'),
        origin.threadId
      )
    ).toBeNull()
    expect(
      nextBoardReturnOrigin(origin, 'backend:account-8', thread, thread, origin.threadId)
    ).toBeNull()
  })
})
