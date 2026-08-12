import { describe, expect, it } from 'vitest'
import { runtimeTaskBoardOrigin } from './runtimeTaskOrigin'

describe('runtimeTaskBoardOrigin', () => {
  it('recognizes persisted board comment origin metadata', () => {
    expect(
      runtimeTaskBoardOrigin({
        runtimeHandle: {
          origin: {
            type: 'board_comment',
            cloudProjectId: 'project-1',
            loopItemId: 'item-1',
          },
        },
      })
    ).toBe('board_comment')
  })

  it('recognizes board task automation origin metadata', () => {
    expect(runtimeTaskBoardOrigin({ runtimeHandle: { origin: { type: 'board_task' } } })).toBe(
      'board_task'
    )
  })

  it('does not classify ordinary runtime tasks as board work', () => {
    expect(runtimeTaskBoardOrigin({ runtimeHandle: { threadId: 'thread-1' } })).toBeNull()
  })
})
