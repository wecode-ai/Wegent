import { describe, expect, it } from 'vitest'
import { collapsedIssueActivity } from './collapsedIssueActivity'

describe('Issue activity folding', () => {
  it.each([0, 1, 20])('retains all %s activities within the threshold', count => {
    const items = Array.from({ length: count }, (_, id) => id)
    expect(collapsedIssueActivity(items, false)).toEqual(items.map(activity => ({ kind: 'activity', activity })))
  })
  it('preserves the earliest two and latest ten while collapsing the middle', () => {
    const items = Array.from({ length: 21 }, (_, id) => id)
    expect(collapsedIssueActivity(items, false)).toEqual([
      { kind: 'activity', activity: 0 }, { kind: 'activity', activity: 1 },
      { kind: 'collapsed', count: 9 },
      ...items.slice(-10).map(activity => ({ kind: 'activity', activity })),
    ])
    expect(collapsedIssueActivity(items, true)).toEqual(items.map(activity => ({ kind: 'activity', activity })))
  })
})
