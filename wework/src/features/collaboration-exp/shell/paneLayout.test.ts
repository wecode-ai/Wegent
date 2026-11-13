import { describe, expect, it } from 'vitest'
import { createDefaultPaneLayout, selectVisiblePaneIds } from './paneLayout'
import type { ExperiencePane } from './types'

const panes: ExperiencePane[] = [
  { id: 'list', title: 'Tasks', content: null, minWidth: 280, defaultWidth: 350 },
  { id: 'timeline', title: 'Timeline', content: null, minWidth: 320 },
  { id: 'discussion', title: 'Private discussion', content: null, minWidth: 320 },
]

describe('experience pane width policy', () => {
  it('matches the prototype navigation, list and home geometry at 817px', () => {
    const layout = createDefaultPaneLayout(
      [
        { id: 'navigation', title: '', content: null, minWidth: 164, defaultWidth: 164 },
        { id: 'list', title: '', content: null, minWidth: 240, defaultWidth: 300 },
        { id: 'home', title: '', content: null, minWidth: 360, defaultWidth: 360 },
      ],
      817
    )
    expect((layout.navigation * 801) / 100).toBeCloseTo(164)
    expect((layout.list * 801) / 100).toBeCloseTo(277)
    expect((layout.home * 801) / 100).toBeCloseTo(360)
  })
  it('shows exactly the newest layer through the 767px mobile boundary', () => {
    expect(selectVisiblePaneIds(panes, 390, null)).toEqual(['discussion'])
    expect(selectVisiblePaneIds(panes, 767, null)).toEqual(['discussion'])
    expect(selectVisiblePaneIds(panes, 768, null)).toEqual(['timeline', 'discussion'])
  })

  it('accounts for navigation and every 8px separator at the desktop threshold', () => {
    expect(selectVisiblePaneIds(panes, 1103, 160)).toEqual(['timeline', 'discussion'])
    expect(selectVisiblePaneIds(panes, 1104, 160)).toEqual(['list', 'timeline', 'discussion'])
    expect(selectVisiblePaneIds(panes, 1104, null)).toEqual(['list', 'timeline', 'discussion'])
  })

  it('retains the newest layer when its minimum exceeds the available width', () => {
    const large = { ...panes[2], minWidth: 1600 }
    expect(selectVisiblePaneIds([...panes.slice(0, 2), large], 1200, 160)).toEqual(['discussion'])
    expect(selectVisiblePaneIds([], 1200, 160)).toEqual([])
  })

  it('preserves preferred navigation/list widths and gives remaining width to the newest pane', () => {
    const layout = createDefaultPaneLayout(
      [{ id: 'nav', title: '', content: null, minWidth: 160, defaultWidth: 160 }, ...panes],
      1440
    )
    const available = 1440 - 3 * 8
    expect((layout.nav * available) / 100).toBeCloseTo(160)
    expect((layout.list * available) / 100).toBeCloseTo(350)
    expect((layout.timeline * available) / 100).toBeCloseTo(320)
    expect((layout.discussion * available) / 100).toBeCloseTo(586)
    expect(Object.values(layout).reduce((sum, value) => sum + value, 0)).toBeCloseTo(100)
  })

  it('shrinks preferred widths within minima before normalizing a narrow single pane', () => {
    const layout = createDefaultPaneLayout(panes, 936)
    expect((layout.list * 920) / 100).toBeCloseTo(280)
    expect((layout.timeline * 920) / 100).toBeCloseTo(320)
    expect((layout.discussion * 920) / 100).toBeCloseTo(320)
    expect(createDefaultPaneLayout([{ ...panes[2], minWidth: 1600 }], 390)).toEqual({
      discussion: 100,
    })
    expect(createDefaultPaneLayout([], 390)).toEqual({})
  })
})
