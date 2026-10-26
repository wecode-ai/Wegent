import { describe, expect, it, vi } from 'vitest'
import type { ProjectBoardColumn } from './ProjectBoardBody'
import {
  executeStandardCloudBoardMutation,
  resolveStandardCloudBoardDrop,
  resolveStandardCloudBoardMutation,
  type StandardCloudBoardItem,
} from './useStandardCloudBoardController'

const baseItem: StandardCloudBoardItem = {
  id: 'moving',
  parent_id: null,
  cloud_project_id: 'project',
  created_at: '2026-09-10T00:00:00Z',
  updated_at: '2026-09-10T00:00:00Z',
  priority: 'high',
  sort_order: 0,
  status: 'pending',
  tags: [],
}

function column(groupValue: string): ProjectBoardColumn {
  return { key: groupValue, groupValue, label: groupValue, status: '', dotClass: '' }
}

describe('board drag source and tag semantics', () => {
  it.each([
    ['red', 'green', ['red', 'blue'], ['blue', 'green']],
    ['red', 'blue', ['red', 'blue'], ['blue']],
    ['red', '', ['red', 'blue'], []],
    ['', 'red', [], ['red']],
  ] as const)(
    'preserves unrelated tags when moving %s to %s',
    async (source, target, tags, expected) => {
      const item = { ...baseItem, tags: [...tags] }
      const mutation = resolveStandardCloudBoardMutation({
        beforeItemId: null,
        column: column(target),
        sourceColumn: column(source),
        groupBy: 'tag',
        item,
        items: [item],
      })!
      expect(mutation).toMatchObject({ kind: 'tag', tags: expected })
      expect(mutation.optimisticItems[0].tags).toEqual(expected)
      const update = vi.fn(async (_item, input) => ({ ...item, ...input }))
      const refreshOrder = vi.fn(async () => {})
      await executeStandardCloudBoardMutation({
        commands: { update, refreshOrder },
        item,
        mutation,
      })
      expect(update).toHaveBeenCalledWith(item, {
        tags: expected,
        position: { beforeItemId: null },
      })
      expect(refreshOrder).toHaveBeenCalledOnce()
      expect(item.tags).toEqual(tags)
    }
  )

  it('reorders within a tag column without rewriting tags', () => {
    const first = { ...baseItem, id: 'first', tags: ['red'], sort_order: 0 }
    const item = { ...baseItem, tags: ['red', 'blue'], sort_order: 1 }
    const input = {
      beforeItemId: first.id,
      column: column('red'),
      sourceColumn: column('red'),
      groupBy: 'tag' as const,
      item,
      items: [first, item],
    }
    expect(resolveStandardCloudBoardMutation(input)).toBeNull()
    const mutation = resolveStandardCloudBoardMutation({ ...input, manualSort: true })!
    expect(mutation).toMatchObject({ kind: 'reorder', position: { beforeItemId: first.id } })
    expect(mutation).not.toHaveProperty('tags')
    expect(mutation.optimisticItems.find(candidate => candidate.id === item.id)?.tags).toEqual([
      'red',
      'blue',
    ])
  })

  it('uses the rendered target column and permits another copy of the same Issue', () => {
    const item = { ...baseItem, tags: ['red', 'blue', 'shared'] }
    const target = { ...item, id: 'target', sort_order: 1 }
    const input = {
      activeItemId: item.id,
      beforeItemId: target.id,
      columnDropKey: 'blue',
      sourceColumnKey: 'red',
      columns: [column('red'), column('blue')],
      extensions: {},
      groupBy: 'tag' as const,
      items: [item, target],
    }
    for (const beforeItemId of [target.id, item.id]) {
      const drop = resolveStandardCloudBoardDrop({ ...input, beforeItemId })!
      expect(drop).toMatchObject({ column: column('blue'), sourceColumn: column('red') })
      expect(drop.beforeItemId).toBe(beforeItemId === item.id ? null : target.id)
      expect(
        resolveStandardCloudBoardMutation({ ...drop, item, items: input.items, groupBy: 'tag' })
      ).toMatchObject({ kind: 'tag', tags: ['blue', 'shared'] })
    }
  })

  it('recognizes the host untagged sentinel', () => {
    const item = { ...baseItem, tags: ['red', 'shared'] }
    const mutation = resolveStandardCloudBoardMutation({
      beforeItemId: null,
      column: column('__no_tag__'),
      sourceColumn: column('red'),
      groupBy: 'tag',
      item,
      items: [item],
      extensions: { noTagGroupValue: '__no_tag__' },
    })!
    expect(mutation).toMatchObject({ kind: 'tag', tags: [] })
  })

  it('rejects cancelled, stale, mismatched and foreign targets', () => {
    const target = { ...baseItem, id: 'target', status: 'completed' }
    const input = {
      activeItemId: baseItem.id,
      beforeItemId: target.id,
      columnDropKey: 'completed',
      sourceColumnKey: 'pending',
      columns: [column('pending'), column('completed')],
      extensions: {},
      groupBy: 'status' as const,
      items: [baseItem, target],
    }
    expect(resolveStandardCloudBoardDrop({ ...input, columnDropKey: null })).toBeNull()
    expect(resolveStandardCloudBoardDrop({ ...input, sourceColumnKey: 'missing' })).toBeNull()
    expect(resolveStandardCloudBoardDrop({ ...input, sourceColumnKey: 'completed' })).toBeNull()
    expect(resolveStandardCloudBoardDrop({ ...input, columnDropKey: 'pending' })).toBeNull()
    expect(resolveStandardCloudBoardDrop({ ...input, beforeItemId: 'missing' })).toBeNull()
    expect(
      resolveStandardCloudBoardDrop({
        ...input,
        beforeItemId: baseItem.id,
        columnDropKey: 'pending',
      })
    ).toBeNull()
    for (const foreign of [{ parent_id: 'other' }, { cloud_project_id: 'other' }]) {
      expect(
        resolveStandardCloudBoardDrop({ ...input, items: [baseItem, { ...target, ...foreign }] })
      ).toBeNull()
    }
    expect(
      resolveStandardCloudBoardMutation({
        beforeItemId: null,
        sourceColumn: column('completed'),
        column: column('pending'),
        groupBy: 'status',
        item: baseItem,
        items: input.items,
        manualSort: true,
      })
    ).toBeNull()
  })
})
