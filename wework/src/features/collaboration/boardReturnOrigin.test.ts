import { describe, expect, it } from 'vitest'
import { retainBoardReturnOrigin, type BoardReturnOrigin } from './boardReturnOrigin'

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
})
