import { describe, expect, it } from 'vitest'
import { collapsedIssueActivity } from './collapsedIssueActivity'

describe('Issue activity folding', () => {
  it('records the hidden message range without rendering or losing the folded middle', () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ sequence: index + 1 }))
    const rows = collapsedIssueActivity(items, false, item => [item.sequence])
    expect(rows).toHaveLength(13)
    expect(rows[2]).toEqual({ kind: 'collapsed', count: 18, firstSequence: 3, lastSequence: 20 })
    expect(collapsedIssueActivity(items, true, item => [item.sequence])).toHaveLength(30)
  })
  it.each([0, 1, 20])('retains all %s activities within the threshold', count => {
    const items = Array.from({ length: count }, (_, id) => id)
    expect(collapsedIssueActivity(items, false)).toEqual(
      items.map(activity => ({ kind: 'activity', activity }))
    )
  })
  it('preserves the earliest two and latest ten while collapsing the middle', () => {
    const items = Array.from({ length: 21 }, (_, id) => id)
    expect(collapsedIssueActivity(items, false)).toEqual([
      { kind: 'activity', activity: 0 },
      { kind: 'activity', activity: 1 },
      { kind: 'collapsed', count: 9 },
      ...items.slice(-10).map(activity => ({ kind: 'activity', activity })),
    ])
    expect(collapsedIssueActivity(items, true)).toEqual(
      items.map(activity => ({ kind: 'activity', activity }))
    )
  })
})
