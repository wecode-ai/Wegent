import { describe, expect, it } from 'vitest'
import type { DragEndEvent } from '@dnd-kit/core'
import { projectBoardDragItemId, projectBoardDrop } from './projectBoardDnd'

function event(over: DragEndEvent['over']): Pick<DragEndEvent, 'active' | 'over'> {
  return {
    active: {
      id: JSON.stringify(['tag', 'tag-red', 'moving']),
      data: { current: { itemId: 'moving', columnKey: 'tag-red', groupBy: 'tag' } },
    } as DragEndEvent['active'],
    over,
  }
}

describe('project board drop identity', () => {
  it('retains the source and actual target column for multi-tag cards', () => {
    const drop = event({
      id: 'todo-card:rendered-copy',
      data: { current: { itemId: 'target', columnKey: 'tag-blue', groupBy: 'tag' } },
    } as DragEndEvent['over'])
    expect(projectBoardDragItemId(drop.active)).toBe('moving')
    expect(projectBoardDrop(drop)).toEqual({
      activeItemId: 'moving',
      beforeItemId: 'target',
      columnDropKey: 'tag-blue',
      sourceColumnKey: 'tag-red',
      groupBy: 'tag',
    })
  })

  it('supports empty-column targets and cancellation without inferring a card column', () => {
    expect(
      projectBoardDrop(
        event({
          id: 'todo-column:tag-untagged',
          data: { current: undefined },
        } as DragEndEvent['over'])
      )
    ).toMatchObject({
      beforeItemId: null,
      columnDropKey: 'tag-untagged',
      sourceColumnKey: 'tag-red',
    })
    expect(projectBoardDrop(event(null))).toMatchObject({ beforeItemId: null, columnDropKey: null })
  })

  it('requires explicit Issue metadata instead of parsing a rendered card identity', () => {
    const drop = event({
      id: `todo-card:${JSON.stringify(['tag', 'tag-blue', 'target'])}`,
      data: { current: { columnKey: 'tag-blue', groupBy: 'tag' } },
    } as DragEndEvent['over'])
    drop.active.data.current = undefined
    expect(projectBoardDragItemId(drop.active)).toBeNull()
    expect(projectBoardDrop(drop)).toMatchObject({ activeItemId: null, beforeItemId: null })
  })
})
