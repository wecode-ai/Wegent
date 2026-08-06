import { describe, expect, test } from 'vitest'
import {
  closeBrowserTab,
  createBrowserTab,
  findBrowserTabForLru,
  moveBrowserTab,
  selectBrowserTab,
  suspendBrowserTab,
} from './browserTabs'

describe('browser tab state', () => {
  test('creates the first tab with the pane label', () => {
    const tab = createBrowserTab('workspace-browser', { id: 'first', now: 10 })

    expect(tab).toMatchObject({
      id: 'first',
      label: 'workspace-browser',
      baseLabel: 'workspace-browser',
      status: 'idle',
      suspended: false,
    })
  })

  test('selects a tab and updates its activity time', () => {
    const first = createBrowserTab('base', { id: 'first', now: 1 })
    const second = createBrowserTab('base', { id: 'second', now: 2 })

    const next = selectBrowserTab({ tabs: [first, second], activeTabId: first.id }, second.id, 20)

    expect(next.activeTabId).toBe(second.id)
    expect(next.tabs[1].lastActiveAt).toBe(20)
  })

  test('closes the active tab and selects its neighbour', () => {
    const tabs = [
      createBrowserTab('base', { id: 'first' }),
      createBrowserTab('base', { id: 'second' }),
      createBrowserTab('base', { id: 'third' }),
    ]

    const next = closeBrowserTab({ tabs, activeTabId: 'second' }, 'second')

    expect(next.tabs.map(tab => tab.id)).toEqual(['first', 'third'])
    expect(next.activeTabId).toBe('third')
  })

  test('moves tabs without mutating the input', () => {
    const tabs = [
      createBrowserTab('base', { id: 'first' }),
      createBrowserTab('base', { id: 'second' }),
      createBrowserTab('base', { id: 'third' }),
    ]

    expect(moveBrowserTab(tabs, 'third', 0).map(tab => tab.id)).toEqual([
      'third',
      'first',
      'second',
    ])
    expect(tabs.map(tab => tab.id)).toEqual(['first', 'second', 'third'])
  })

  test('skips protected tabs when selecting an LRU candidate', () => {
    const protectedTab = {
      ...createBrowserTab('base', { id: 'protected', now: 1 }),
      nativeLabel: 'native-protected',
      agentControlled: true,
    }
    const candidate = {
      ...createBrowserTab('base', { id: 'candidate', now: 2 }),
      nativeLabel: 'native-candidate',
    }

    expect(findBrowserTabForLru([protectedTab, candidate], 2)?.id).toBe('candidate')
  })

  test('suspends a tab while preserving its navigation metadata', () => {
    const tab = {
      ...createBrowserTab('base', { id: 'tab', url: 'https://example.test/' }),
      nativeLabel: 'native-tab',
      status: 'ready' as const,
    }

    expect(suspendBrowserTab(tab)).toMatchObject({
      url: 'https://example.test/',
      nativeLabel: null,
      suspended: true,
      status: 'idle',
    })
  })
})
