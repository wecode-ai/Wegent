import { describe, expect, it } from 'vitest'
import {
  projectBoardDragItemId,
  projectBoardDrop,
  projectBoardRowDropId,
  type ProjectBoardDropInput,
} from './projectBoardDnd'

function input(target: ProjectBoardDropInput['target']): ProjectBoardDropInput {
  return {
    source: {
      id: JSON.stringify(['tag', 'tag-red', 'moving']),
      itemId: 'moving',
      columnKey: 'tag-red',
      groupBy: 'tag',
    },
    target,
  }
}
describe('project board drop identity', () => {
  it('carries row ownership for empty cells without conflating parent and lane IDs', () => {
    const targetParentId = 'parent:with/slashes'
    const columnKey = 'tag:design/研发'
    expect(
      projectBoardDrop(
        input({ id: projectBoardRowDropId(targetParentId, columnKey) }),
      ),
    ).toMatchObject({ targetParentId, columnDropKey: columnKey })
    expect(
      projectBoardDrop(input({ id: projectBoardRowDropId(null, columnKey) })),
    ).toMatchObject({ targetParentId: null })
    expect(
      projectBoardDrop(input({ id: 'todo-row-column:not-json' })),
    ).toMatchObject({ columnDropKey: null })
  })
  it('retains the source and actual target column for multi-tag cards', () => {
    const drop = input({
      id: 'rendered-copy',
      itemId: 'target',
      columnKey: 'tag-blue',
      groupBy: 'tag',
    })
    expect(projectBoardDragItemId(drop.source)).toBe('moving')
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
      projectBoardDrop(input({ id: 'todo-column:tag-untagged' })),
    ).toMatchObject({
      beforeItemId: null,
      columnDropKey: 'tag-untagged',
      sourceColumnKey: 'tag-red',
    })
    expect(projectBoardDrop(input(null))).toMatchObject({
      beforeItemId: null,
      columnDropKey: null,
    })
  })
  it('requires explicit Issue metadata instead of parsing a rendered card identity', () => {
    const drop = input({
      id: JSON.stringify(['tag', 'tag-blue', 'target']),
      columnKey: 'tag-blue',
      groupBy: 'tag',
    })
    drop.source.itemId = undefined
    expect(projectBoardDragItemId(drop.source)).toBeNull()
    expect(projectBoardDrop(drop)).toMatchObject({
      activeItemId: null,
      beforeItemId: null,
    })
  })
})
