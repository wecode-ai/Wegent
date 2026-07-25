import type { CloudLoopItem } from '@/api/deliveries'
import { reorderLaneItems } from './todoShared'

function laneItem(id: string, overrides: Partial<CloudLoopItem> = {}): CloudLoopItem {
  return {
    id,
    cloud_project_id: '11',
    sequence_number: 1,
    parent_id: null,
    created_by_user_id: 1,
    assignee_user_id: null,
    title: id,
    description: '',
    status: 'inbox',
    priority: 'none',
    due_at: null,
    tags: [],
    sort_order: 0,
    current_delivery_id: null,
    version: 1,
    created_at: '2026-07-22T00:00:00Z',
    updated_at: '2026-07-22T00:00:00Z',
    completed_at: null,
    ...overrides,
  }
}

describe('reorderLaneItems', () => {
  it('moves a card up within its lane', () => {
    const items = [laneItem('WEG-1'), laneItem('WEG-2'), laneItem('WEG-3')]
    const reordered = reorderLaneItems(items, 'WEG-3', 'inbox', 'WEG-1')

    expect(reordered?.laneIds).toEqual(['WEG-3', 'WEG-1', 'WEG-2'])
    const laneOrder = reordered!.items.filter(item => item.status === 'inbox').map(item => item.id)
    expect(laneOrder).toEqual(['WEG-3', 'WEG-1', 'WEG-2'])
  })

  it('appends a card at the end of another lane', () => {
    const items = [
      laneItem('WEG-1'),
      laneItem('WEG-2', { status: 'pending' }),
      laneItem('WEG-3', { status: 'pending' }),
    ]
    const reordered = reorderLaneItems(items, 'WEG-1', 'pending', null)

    expect(reordered?.laneIds).toEqual(['WEG-2', 'WEG-3', 'WEG-1'])
    const pending = reordered!.items.filter(item => item.status === 'pending')
    expect(pending.map(item => item.id)).toEqual(['WEG-2', 'WEG-3', 'WEG-1'])
    expect(pending.at(-1)?.id).toBe('WEG-1')
  })

  it('keeps other lanes and hierarchy layers untouched', () => {
    const items = [
      laneItem('WEG-1'),
      laneItem('WEG-2'),
      laneItem('WEG-3', { parent_id: 'WEG-1' }),
      laneItem('WEG-4', { status: 'pending' }),
    ]
    const reordered = reorderLaneItems(items, 'WEG-2', 'inbox', 'WEG-1')

    expect(reordered?.laneIds).toEqual(['WEG-2', 'WEG-1'])
    expect(reordered!.items.find(item => item.id === 'WEG-3')?.parent_id).toBe('WEG-1')
    expect(reordered!.items.filter(item => item.status === 'pending').map(item => item.id)).toEqual(
      ['WEG-4']
    )
  })

  it('returns null for drops that change nothing', () => {
    const items = [laneItem('WEG-1'), laneItem('WEG-2')]

    // Already right before the drop target.
    expect(reorderLaneItems(items, 'WEG-1', 'inbox', 'WEG-2')).toBeNull()
    // Plain drop on the same lane.
    expect(reorderLaneItems(items, 'WEG-1', 'inbox', null)).toBeNull()
    // Unknown card.
    expect(reorderLaneItems(items, 'WEG-9', 'inbox', null)).toBeNull()
  })
})
