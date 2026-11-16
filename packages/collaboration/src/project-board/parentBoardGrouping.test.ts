import { describe, expect, it } from 'vitest'
import { projectBoardParentRows, type ParentBoardItem } from './parentBoardGrouping'
import { matchesStandardCloudBoardColumn } from './useStandardCloudBoardController'
import type { ProjectBoardColumn } from './ProjectBoardBody'

const columns: ProjectBoardColumn[] = ['design', 'develop', 'test'].map(tag => ({
  key: tag,
  type: 'tag',
  groupValue: tag,
  label: tag,
  dotClass: '',
  status: '',
}))
type Item = ParentBoardItem & {
  tags: string[]
  priority: string
  sort_order: number
  created_at: string
  updated_at: string
}
const item = (id: string, parent: string | null, tags: string[], status = 'in_progress'): Item => ({
  id,
  title: id,
  parent_id: parent,
  tags,
  status,
  priority: '',
  sort_order: 0,
  created_at: '',
  updated_at: '',
})
const items = [
  item('parent', null, []),
  item('front', 'parent', ['develop']),
  item('back', 'parent', ['develop', 'test'], 'completed'),
  item('tests', 'parent', ['test']),
  item('grandchild', 'front', ['design']),
  item('standalone', null, ['design']),
]
function group(source = items, currentParentId: string | null = null, query = '') {
  return projectBoardParentRows({
    items: source,
    currentParentId,
    columns,
    getColumnItems: (column, parentId) =>
      source.filter(
        r =>
          r.parent_id === parentId &&
          matchesStandardCloudBoardColumn(r, column, 'tag', {}) &&
          r.title.includes(query)
      ),
  })
}

describe('parent board grouping', () => {
  it('shows parallel direct children once in progress counts despite multi-tag copies', () => {
    const rows = group()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      parentId: 'parent',
      total: 3,
      completed: 1,
      running: 2,
    })
    expect(rows[0].items.get('develop')?.map(r => r.id)).toEqual(['front', 'back'])
    expect(rows[0].items.get('test')?.map(r => r.id)).toEqual(['back', 'tests'])
    expect(rows[0].items.get('design')).toEqual([])
    expect(rows[1].items.get('design')?.map(r => r.id)).toEqual(['standalone'])
  })
  it('keeps nested work accessible at its own parent layer', () => {
    const rows = group(items, 'parent')
    expect(rows[0]).toMatchObject({ parentId: 'front', total: 1 })
    expect(rows[0].items.get('design')?.map(r => r.id)).toEqual(['grandchild'])
  })
  it('never includes restricted children or their status in summaries', () => {
    const rows = group([
      ...items,
      {
        ...item('private', 'parent', ['develop'], 'completed'),
        can_view_detail: false,
      },
    ])
    expect(rows[0]).toMatchObject({ total: 3, completed: 1, running: 2 })
    expect(rows[0].items.get('develop')?.map(r => r.id)).not.toContain('private')
  })
  it('does not expose a restricted parent title or orphan readable children', () => {
    const rows = group(items.map(r => (r.id === 'parent' ? { ...r, can_view_detail: false } : r)))
    expect(rows.every(r => r.parent?.id !== 'parent')).toBe(true)
    expect(rows.flatMap(r => [...r.items.values()].flat()).map(r => r.id)).toContain('back')
  })
  it('matches children independently of parent tags and keeps totals scoped to readable direct children', () => {
    const rows = group(items, null, 'front')
    expect(rows).toHaveLength(1)
    expect(rows[0].items.get('develop')?.map(r => r.id)).toEqual(['front'])
    expect(rows[0].total).toBe(3)
    expect(group(items, null, 'no match')).toEqual([])
    expect(group([])).toEqual([])
  })
})
