// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest'

import type { ProjectBoardColumn } from './ProjectBoardBody'
import {
  buildStandardCloudBoardBreadcrumb,
  createStandardCloudBoardColumns,
  executeStandardCloudBoardMutation,
  filterStandardCloudBoardItems,
  mergePersistedBoardMove,
  resolveStandardCloudBoardDrop,
  resolveStandardCloudBoardMutation,
  type StandardCloudBoardHostExtensions,
  type StandardCloudBoardItem,
} from './useStandardCloudBoardController'

interface Item extends StandardCloudBoardItem {
  assignee: string
  title: string
}

const items: Item[] = [
  {
    id: 'parent',
    created_at: '2026-09-10T00:00:00Z',
    updated_at: '2026-09-10T00:00:00Z',
    parent_id: null,
    priority: 'high',
    sort_order: 0,
    status: 'pending',
    tags: [],
    assignee: 'alice',
    title: 'Parent issue',
  },
  {
    id: 'child-a',
    created_at: '2026-09-10T00:00:00Z',
    updated_at: '2026-09-10T00:00:00Z',
    parent_id: 'parent',
    priority: 'high',
    sort_order: 2,
    status: 'pending',
    tags: ['frontend'],
    assignee: 'alice',
    assignee_user_id: 1,
    assignee_name: 'alice',
    title: 'Searchable child',
  },
  {
    id: 'child-b',
    created_at: '2026-09-10T00:00:00Z',
    updated_at: '2026-09-10T00:00:00Z',
    parent_id: 'parent',
    priority: 'low',
    sort_order: 1,
    status: 'completed',
    tags: [],
    assignee: 'bob',
    assignee_user_id: 2,
    assignee_name: 'bob',
    title: 'Other child',
  },
]

const extensions: StandardCloudBoardHostExtensions<Item> = {
  getSearchText: item => `${item.title} ${item.assignee}`,
}

function column(groupValue: string): ProjectBoardColumn {
  return {
    dotClass: 'bg-zinc-400',
    groupValue,
    key: groupValue,
    label: groupValue,
    status: groupValue,
  }
}

function sourceColumn(item: Item, groupBy: 'status' | 'priority' | 'assignee' | 'tag') {
  const groupValue =
    groupBy === 'status'
      ? item.status
      : groupBy === 'priority'
        ? item.priority
        : groupBy === 'tag'
          ? (item.tags[0] ?? '')
          : item.assignee_user_id == null
            ? ''
            : String(item.assignee_user_id)
  return column(groupValue)
}

describe('standard cloud board controller', () => {
  it('keeps external provider field moves without advertising manual persistence', () => {
    const item = items[0]
    expect(
      resolveStandardCloudBoardMutation({
        item,
        items: [item],
        groupBy: 'status',
        column: column('pending'),
        manualSort: true,
        supportsOrder: false,
        beforeItemId: null,
        sourceColumn: sourceColumn(item, 'status'),
      })
    ).toBeNull()
    const move = resolveStandardCloudBoardMutation({
      item,
      items: [item],
      groupBy: 'priority',
      column: column('urgent'),
      supportsOrder: false,
      beforeItemId: null,
      sourceColumn: sourceColumn(item, 'priority'),
    })
    expect(move).toMatchObject({ kind: 'priority', priority: 'urgent' })
    expect(move).not.toHaveProperty('position')
  })

  it('orders equal ranks consistently before and after a refreshed snapshot', () => {
    const earlier = {
      ...items[0],
      id: 'A',
      updated_at: '2026-09-10T00:00:00Z',
    }
    const later = { ...earlier, id: 'B', updated_at: '2026-09-11T00:00:00Z' }
    const tied = { ...later, id: 'C' }
    const state = {
      groupBy: 'status' as const,
      groupFilter: '',
      query: '',
      getColumnSort: () => [],
    }
    const order = (boardItems: Item[]) =>
      filterStandardCloudBoardItems({
        column: column('pending'),
        currentParentId: null,
        extensions,
        items: boardItems,
        state,
      }).map(item => item.id)
    expect(order([earlier, tied, later])).toEqual(['B', 'C', 'A'])
    expect(order([later, earlier, tied])).toEqual(['B', 'C', 'A'])
  })

  it.each(['status', 'assignee', 'tag'] as const)(
    'sorts %s columns by priority and keeps manual order for ties',
    groupBy => {
      const priorities = ['none', 'low', 'high', 'urgent', 'medium', 'high']
      const unordered = priorities.map((priority, sort_order) => ({
        ...items[0],
        id: String(sort_order),
        priority,
        sort_order,
        assignee_user_id: 1,
        tags: ['frontend'],
      }))
      const input = {
        column: column({ status: 'pending', assignee: '1', tag: 'frontend' }[groupBy]),
        currentParentId: null,
        extensions,
        items: unordered,
        state: {
          groupBy,
          groupFilter: '',
          query: '',
          getColumnSort: () => ['priority-desc'] as const,
        },
      }
      expect(filterStandardCloudBoardItems(input).map(item => item.id)).toEqual([
        '3',
        '2',
        '5',
        '4',
        '1',
        '0',
      ])
      expect(
        filterStandardCloudBoardItems({
          ...input,
          state: { ...input.state, getColumnSort: () => [] },
        }).map(item => item.id)
      ).toEqual(['0', '1', '2', '3', '4', '5'])
      expect(unordered.map(item => item.id)).toEqual(['0', '1', '2', '3', '4', '5'])
      expect(
        filterStandardCloudBoardItems({
          ...input,
          state: { ...input.state, query: 'missing' },
        })
      ).toEqual([])
      expect(filterStandardCloudBoardItems({ ...input, currentParentId: 'other' })).toEqual([])
    }
  )

  it('keeps the local user with ID zero in the assigned board column', () => {
    const localItem = {
      ...items[0],
      assignee_user_id: 0,
      assignee_name: 'Me',
    }
    expect(
      filterStandardCloudBoardItems({
        column: column('0'),
        currentParentId: null,
        extensions,
        items: [localItem],
        state: {
          groupBy: 'assignee',
          groupFilter: '',
          query: '',
          getColumnSort: () => ['priority-desc'],
        },
      }).map(item => item.id)
    ).toEqual([localItem.id])
    expect(
      filterStandardCloudBoardItems({
        column: column(''),
        currentParentId: null,
        extensions,
        items: [localItem],
        state: {
          groupBy: 'assignee',
          groupFilter: '',
          query: '',
          getColumnSort: () => ['priority-desc'],
        },
      })
    ).toEqual([])
  })
  it('builds a cycle-safe parent breadcrumb', () => {
    expect(buildStandardCloudBoardBreadcrumb(items, 'child-a').map(item => item.id)).toEqual([
      'parent',
      'child-a',
    ])
  })

  it('owns standard parent, group, search and sort filtering', () => {
    expect(
      filterStandardCloudBoardItems({
        column: column('pending'),
        currentParentId: 'parent',
        extensions,
        items,
        state: {
          groupBy: 'status',
          groupFilter: '',
          query: 'searchable',
          getColumnSort: () => ['priority-desc'],
        },
      }).map(item => item.id)
    ).toEqual(['child-a'])
  })

  it('resolves both card and column drops with shared assignee semantics', () => {
    expect(
      resolveStandardCloudBoardDrop({
        activeItemId: 'child-a',
        beforeItemId: 'child-b',
        columnDropKey: '2',
        sourceColumnKey: '1',
        columns: [column('1'), column('2')],
        extensions,
        groupBy: 'assignee',
        items,
      })
    ).toEqual({
      beforeItemId: 'child-b',
      column: column('2'),
      sourceColumn: column('1'),
      itemId: 'child-a',
    })
    expect(
      resolveStandardCloudBoardDrop({
        activeItemId: 'child-a',
        beforeItemId: null,
        columnDropKey: 'pending',
        sourceColumnKey: 'pending',
        columns: [column('pending')],
        extensions,
        groupBy: 'status',
        items,
      })
    ).toEqual({
      beforeItemId: null,
      column: column('pending'),
      sourceColumn: column('pending'),
      itemId: 'child-a',
    })
  })

  it('owns status, priority, assignee and tag column modeling', () => {
    const columnOptions = {
      assignees: [
        { id: '7', name: 'Ada', type: 'user' as const },
        { id: 'bot-1', name: 'Codex', type: 'agent' as const },
      ],
      items: [
        {
          ...items[0],
          assignee_user_id: 7,
          assignee_name: 'Ada',
          tags: ['frontend'],
        },
      ],
      labels: {
        noPriority: 'Normal',
        noTag: 'No tag',
        priority: {
          low: 'Low',
          medium: 'Medium',
          high: 'High',
          urgent: 'Urgent',
        },
        unassigned: 'Unassigned',
      },
      statuses: [{ id: 'pending', name: 'Pending', color: 'blue' }],
      tags: ['backend'],
    }

    expect(
      createStandardCloudBoardColumns({
        ...columnOptions,
        groupBy: 'status',
      }).map(({ groupValue, label }) => [groupValue, label])
    ).toEqual([['pending', 'Pending']])
    expect(
      createStandardCloudBoardColumns({
        ...columnOptions,
        groupBy: 'priority',
      }).map(({ groupValue, label }) => [groupValue, label])
    ).toEqual([
      ['urgent', 'Urgent'],
      ['high', 'High'],
      ['medium', 'Medium'],
      ['low', 'Low'],
      ['none', 'Normal'],
    ])
    expect(
      createStandardCloudBoardColumns({
        ...columnOptions,
        groupBy: 'assignee',
      }).map(({ groupValue, label }) => [groupValue, label])
    ).toEqual([
      ['7', 'Ada'],
      ['agent:bot-1', 'Codex'],
      ['', 'Unassigned'],
    ])
    expect(
      createStandardCloudBoardColumns({
        ...columnOptions,
        groupBy: 'tag',
      }).map(({ groupValue, label }) => [groupValue, label])
    ).toEqual([
      ['backend', 'backend'],
      ['frontend', 'frontend'],
      ['', 'No tag'],
    ])
  })

  it('resolves every standard drop into one shared field mutation', () => {
    const item = {
      ...items[0],
      assignee_user_id: 1,
      assignee_name: 'Alice',
    }
    const boardItems = [item, items[2]]

    expect(
      resolveStandardCloudBoardMutation({
        beforeItemId: null,
        column: column('completed'),
        groupBy: 'status',
        item,
        items: boardItems,
        sourceColumn: sourceColumn(item, 'status'),
      })
    ).toMatchObject({
      kind: 'status',
      position: { beforeItemId: null },
      status: 'completed',
    })
    const priorityMutation = resolveStandardCloudBoardMutation({
      beforeItemId: null,
      column: column('urgent'),
      groupBy: 'priority',
      item,
      items: boardItems,
      sourceColumn: sourceColumn(item, 'priority'),
    })
    expect(priorityMutation).toMatchObject({
      kind: 'priority',
      priority: 'urgent',
    })
    expect(
      priorityMutation?.optimisticItems.find(candidate => candidate.id === item.id)
    ).toMatchObject({ priority: 'urgent' })
    const assigneeMutation = resolveStandardCloudBoardMutation({
      beforeItemId: null,
      column: column('agent:bot-1'),
      groupBy: 'assignee',
      item,
      items: boardItems,
      sourceColumn: sourceColumn(item, 'assignee'),
    })
    expect(assigneeMutation).toMatchObject({
      kind: 'assignee',
      assigneeId: 'bot-1',
      assigneeType: 'agent',
    })
    expect(
      assigneeMutation?.optimisticItems.find(candidate => candidate.id === item.id)
    ).toMatchObject({
      assignee_user_id: null,
      assignee_agent_id: 'bot-1',
    })
    const tagMutation = resolveStandardCloudBoardMutation({
      beforeItemId: null,
      column: column('backend'),
      groupBy: 'tag',
      item,
      items: boardItems,
      sourceColumn: sourceColumn(item, 'tag'),
    })
    expect(tagMutation).toMatchObject({
      kind: 'tag',
      tags: ['backend'],
    })
    expect(tagMutation?.optimisticItems.find(candidate => candidate.id === item.id)).toMatchObject({
      tags: ['backend'],
    })
  })

  it('saves fields and position once before refreshing the canonical order', async () => {
    const item = { ...items[0], version: 3 }
    const updated = { ...item, status: 'completed', version: 4 }
    const update = vi.fn(async () => updated)
    const assign = vi.fn(async () => updated)
    const refreshOrder = vi.fn(async () => {})
    const commands = { assign, update, refreshOrder }
    const mutation = resolveStandardCloudBoardMutation({
      beforeItemId: null,
      column: column('completed'),
      groupBy: 'status',
      item,
      items: [item],
      sourceColumn: sourceColumn(item, 'status'),
    })!
    await executeStandardCloudBoardMutation({
      additionalUpdate: { automation_rule_id: 'rule-1' },
      commands,
      item,
      mutation,
    })
    expect(update).toHaveBeenCalledWith(item, {
      automation_rule_id: 'rule-1',
      status: 'completed',
      position: { beforeItemId: null },
    })
    expect(refreshOrder).toHaveBeenCalledWith(updated)
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(
      refreshOrder.mock.invocationCallOrder[0]
    )
    expect(assign).not.toHaveBeenCalled()

    const assignment = resolveStandardCloudBoardMutation({
      beforeItemId: null,
      column: column('agent:bot-1'),
      groupBy: 'assignee',
      item,
      items: [item],
      sourceColumn: sourceColumn(item, 'assignee'),
    })!
    await executeStandardCloudBoardMutation({
      commands,
      item,
      mutation: assignment,
      notifyAssignee: false,
    })
    expect(assign).toHaveBeenCalledWith(item, {
      assigneeId: 'bot-1',
      assigneeType: 'agent',
      notifyAssignee: false,
      position: { beforeItemId: null },
    })
    expect(refreshOrder).toHaveBeenCalledTimes(2)
  })

  it('does not refresh or report success after a failed atomic move', async () => {
    const item = items[0]
    const mutation = resolveStandardCloudBoardMutation({
      beforeItemId: null,
      column: column('urgent'),
      groupBy: 'priority',
      item,
      items: [item],
      sourceColumn: sourceColumn(item, 'priority'),
    })!
    const update = vi.fn().mockRejectedValue(new Error('write failed'))
    const refreshOrder = vi.fn()
    await expect(
      executeStandardCloudBoardMutation({
        commands: { update, refreshOrder },
        item,
        mutation,
      })
    ).rejects.toThrow('write failed')
    expect(refreshOrder).not.toHaveBeenCalled()
  })

  it('uses one positioned update for priority, tag and unassignment', async () => {
    const item = { ...items[0], assignee_user_id: 99 }
    const update = vi.fn(async (_item, input) => ({ ...item, ...input }))
    const commands = { update, refreshOrder: vi.fn(async () => {}) }
    for (const [groupBy, groupValue] of [
      ['priority', 'urgent'],
      ['tag', 'backend'],
      ['assignee', ''],
    ] as const) {
      const mutation = resolveStandardCloudBoardMutation({
        beforeItemId: null,
        column: column(groupValue),
        groupBy,
        item,
        items: [item],
        sourceColumn: sourceColumn(item, groupBy),
      })!
      await executeStandardCloudBoardMutation({ commands, item, mutation })
    }
    expect(update.mock.calls.map(([, input]) => input)).toEqual([
      { priority: 'urgent', position: { beforeItemId: null } },
      { tags: ['backend'], position: { beforeItemId: null } },
      {
        assignee_user_id: null,
        assignee_agent_id: null,
        assignee_team_id: null,
        position: { beforeItemId: null },
      },
    ])
  })
})

describe('committed board positions', () => {
  it('keeps hidden sibling rank gaps when moving backward before a visible anchor', () => {
    const first = {
      ...items[0],
      id: 'a',
      parent_id: null,
      sort_order: 0,
      version: 1,
    }
    const second = { ...first, id: 'b', sort_order: 2 }
    const third = { ...first, id: 'c', sort_order: 4 }
    const saved = { ...first, version: 2, sort_order: 3 }

    const result = mergePersistedBoardMove([first, second, third], saved, {
      beforeItemId: third.id,
    })

    expect(result.slice().sort((a, b) => a.sort_order - b.sort_order)).toEqual([
      { ...second, sort_order: 1 },
      saved,
      third,
    ])
  })

  it.each([
    {
      moved: 'c',
      before: 'a',
      rank: 0,
      expected: [
        ['c', 0],
        ['a', 1],
        ['b', 3],
      ],
    },
    {
      moved: 'a',
      before: null,
      rank: 4,
      expected: [
        ['b', 1],
        ['c', 3],
        ['a', 4],
      ],
    },
  ])(
    'preserves sparse global ranks for $moved before $before',
    ({ moved, before, rank, expected }) => {
      const siblings = ['a', 'b', 'c'].map((id, index) => ({
        ...items[0],
        id,
        parent_id: null,
        sort_order: index * 2,
        version: 1,
      }))
      const saved = {
        ...siblings.find(item => item.id === moved)!,
        version: 2,
        sort_order: rank,
      }
      const result = mergePersistedBoardMove(siblings, saved, {
        beforeItemId: before,
      })
      expect(
        result
          .slice()
          .sort((a, b) => a.sort_order - b.sort_order)
          .map(item => [item.id, item.sort_order])
      ).toEqual(expected)
    }
  )

  it('uses the visible anchor when cached sibling ranks changed concurrently', () => {
    const siblings = ['a', 'b', 'c'].map((id, index) => ({
      ...items[0],
      id,
      parent_id: null,
      sort_order: index,
      version: 1,
    }))
    const saved = { ...siblings[0], version: 2, sort_order: 4 }
    const result = mergePersistedBoardMove(siblings, saved, {
      beforeItemId: 'c',
    })
    expect(
      result
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order)
        .map(item => item.id)
    ).toEqual(['b', 'a', 'c'])
  })

  it('rebases sibling ranks without overwriting concurrent fields or other parents', () => {
    const first = {
      ...items[0],
      id: 'a',
      parent_id: null,
      sort_order: 0,
      version: 1,
    }
    const second = {
      ...first,
      id: 'b',
      sort_order: 1,
      title: 'Concurrent title',
      tags: ['new'],
      version: 4,
    }
    const third = { ...first, id: 'c', sort_order: 2 }
    const child = { ...first, id: 'child', parent_id: 'a' }
    const saved = { ...first, version: 2, sort_order: 1 }
    const result = mergePersistedBoardMove([first, second, third, child], saved, {
      beforeItemId: third.id,
    })
    expect(result).toEqual([saved, { ...second, sort_order: 0 }, third, child])
    expect(
      mergePersistedBoardMove(result, { ...first, sort_order: 0 }, { beforeItemId: second.id })
    ).toBe(result)
    expect(mergePersistedBoardMove(result, saved, { beforeItemId: third.id })).toBe(result)
  })
})

describe('canonical manual order for every grouping', () => {
  it.each(['status', 'priority', 'assignee', 'tag'] as const)(
    'moves to a card and lane tail in %s without changing unrelated fields',
    async groupBy => {
      const first = {
        ...items[0],
        id: 'first',
        priority: 'high',
        assignee_user_id: 42,
        tags: ['backend', 'shared'],
        sort_order: 0,
      }
      const hidden = {
        ...first,
        id: 'hidden',
        priority: 'low',
        assignee_user_id: null,
        tags: [],
        status: 'inbox',
        sort_order: 1,
      }
      const last = {
        ...first,
        id: 'last',
        status: groupBy === 'status' ? 'pending' : 'completed',
        sort_order: 2,
      }
      const child = {
        ...first,
        id: 'child',
        parent_id: first.id,
        sort_order: 0,
      }
      const otherProject = {
        ...first,
        id: 'other-project',
        cloud_project_id: 'foreign',
        sort_order: 0,
      }
      const boardItems = [last, child, first, hidden, otherProject]
      const target = column(
        { status: 'pending', priority: 'high', assignee: '42', tag: 'backend' }[groupBy]
      )
      const mutation = resolveStandardCloudBoardMutation({
        beforeItemId: first.id,
        column: target,
        groupBy,
        item: last,
        items: boardItems,
        manualSort: true,
        sourceColumn: sourceColumn(last, groupBy),
      })!
      expect(mutation).toMatchObject({
        kind: 'reorder',
        position: { beforeItemId: first.id },
      })
      const update = vi.fn(async () => ({
        ...last,
        sort_order: 0,
        version: 9,
      }))
      const refreshOrder = vi.fn(async () => {})
      const saved = await executeStandardCloudBoardMutation({
        item: last,
        mutation,
        commands: { update, refreshOrder },
      })
      expect(update).toHaveBeenCalledWith(last, {
        position: { beforeItemId: first.id },
      })
      expect(saved).toMatchObject({
        version: 9,
        sort_order: 0,
        tags: ['backend', 'shared'],
      })
      expect(mutation.optimisticItems.find(item => item.id === child.id)).toEqual(child)
      expect(mutation.optimisticItems.find(item => item.id === otherProject.id)).toEqual(
        otherProject
      )
      const orderedIds = (result: typeof mutation) =>
        result.optimisticItems
          .filter(item => !item.parent_id && !item.cloud_project_id)
          .sort((a, b) => a.sort_order - b.sort_order)
          .map(item => item.id)
      expect(orderedIds(mutation)).toEqual(['last', 'first', 'hidden'])
      const append = resolveStandardCloudBoardMutation({
        beforeItemId: null,
        column: target,
        groupBy,
        item: last,
        items: mutation.optimisticItems,
        manualSort: true,
        sourceColumn: sourceColumn(last, groupBy),
      })!
      expect(append.position).toEqual({ beforeItemId: 'hidden' })
      expect(orderedIds(append)).toEqual(['first', 'last', 'hidden'])
      expect(
        resolveStandardCloudBoardMutation({
          beforeItemId: 'child',
          column: target,
          groupBy,
          item: last,
          items: boardItems,
          manualSort: true,
          sourceColumn: sourceColumn(last, groupBy),
        })
      ).toBeNull()
      expect(
        resolveStandardCloudBoardMutation({
          beforeItemId: first.id,
          column: target,
          groupBy,
          item: last,
          items: boardItems,
          sourceColumn: sourceColumn(last, groupBy),
        })
      ).toBeNull()
      expect(
        resolveStandardCloudBoardMutation({
          beforeItemId: null,
          column: target,
          groupBy,
          item: last,
          items: append.optimisticItems,
          manualSort: true,
          sourceColumn: sourceColumn(last, groupBy),
        })
      ).toBeNull()
    }
  )

  it.each(['status', 'priority', 'assignee', 'tag'] as const)(
    'positions cross-column %s moves against the full sibling order',
    groupBy => {
      const first = {
        ...items[0],
        id: 'first',
        assignee_user_id: 42,
        tags: ['backend'],
        sort_order: 0,
      }
      const moved = {
        ...first,
        id: 'moved',
        priority: 'low',
        status: 'completed',
        assignee_user_id: 7,
        tags: ['frontend'],
        sort_order: 2,
      }
      const hidden = {
        ...first,
        id: 'hidden',
        status: 'inbox',
        priority: 'none',
        tags: [],
        assignee_user_id: null,
        sort_order: 1,
      }
      const target = column(
        { status: 'pending', priority: 'high', assignee: '42', tag: 'backend' }[groupBy]
      )
      const manual = resolveStandardCloudBoardMutation({
        beforeItemId: first.id,
        column: target,
        groupBy,
        item: moved,
        items: [first, hidden, moved],
        manualSort: true,
        sourceColumn: sourceColumn(moved, groupBy),
      })!
      expect(manual.position).toEqual({ beforeItemId: first.id })
      const automatic = resolveStandardCloudBoardMutation({
        beforeItemId: first.id,
        column: target,
        groupBy,
        item: moved,
        items: [first, hidden, moved],
        sourceColumn: sourceColumn(moved, groupBy),
      })!
      expect(automatic.position).toEqual({ beforeItemId: hidden.id })
    }
  )

  it('uses a single anchor for projects with more than 1000 siblings', () => {
    const siblings = Array.from({ length: 1001 }, (_, index) => ({
      ...items[0],
      id: String(index),
      sort_order: index,
    }))
    const mutation = resolveStandardCloudBoardMutation({
      beforeItemId: '0',
      column: column('pending'),
      groupBy: 'status',
      item: siblings[1000],
      items: siblings,
      manualSort: true,
      sourceColumn: sourceColumn(siblings[1000], 'status'),
    })!
    expect(mutation.position).toEqual({ beforeItemId: '0' })
    expect(mutation).not.toHaveProperty('laneIds')
  })

  it('uses the actual target lane for cards with multiple tags', () => {
    const target = { ...items[0], id: 'target', tags: ['backend', 'shared'] }
    const backend = { ...column('backend'), key: 'tag-backend' }
    const shared = { ...column('shared'), key: 'tag-shared' }
    expect(
      resolveStandardCloudBoardDrop({
        activeItemId: 'moved',
        sourceColumnKey: backend.key,
        beforeItemId: target.id,
        columnDropKey: shared.key,
        columns: [backend, shared],
        extensions: {},
        groupBy: 'tag',
        items: [{ ...target, id: 'moved' }, target],
      })?.column
    ).toEqual(shared)
  })
})
