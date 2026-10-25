import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, test } from 'vitest'
import { navigateTo } from '@/lib/navigation'
import { installDshUiTestContributions } from '@/test/setup'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import type { WorkspaceTabsContextValue } from './workspaceTabsContextValue'
import { RoutingHarness } from './workspaceTabsTestHarness'

describe('workspace destination navigation', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    delete window.__WEWORK_RUNTIME_CONFIG__
    window.history.replaceState({}, '', '/')
  })

  test.each([
    '/',
    '/runtime-tasks?deviceId=device&taskId=completed',
    '/todo?projectId=two',
    '/app/wegent',
  ])(
    'routes built-in navigation to its own tab without replacing another kind: %s',
    contentRoute => {
      window.history.replaceState({}, '', contentRoute === '/app/wegent' ? '/todo' : '/app/wegent')
      let current!: WorkspaceTabsContextValue
      render(
        <RoutingHarness
          onContextValue={value => {
            current = value
          }}
        />
      )
      const source = { ...current.activeTab }
      const count = current.tabs.length

      act(() => navigateTo(contentRoute))

      expect(current.activeTabId).not.toBe(source.id)
      expect(current.activeTab.contentRoute).toBe(contentRoute)
      expect(current.tabs.find(tab => tab.id === source.id)).toEqual(source)
      expect(current.tabs).toHaveLength(count)
      const destinationId = current.activeTabId
      act(() => current.selectTab(source.id))
      act(() => navigateTo(contentRoute))
      expect(current.activeTabId).toBe(destinationId)
      expect(current.tabs).toHaveLength(count)
    }
  )

  test('direct task navigation selects the matching conversation before other task tabs', () => {
    window.history.replaceState({}, '', '/todo?projectId=one')
    let current!: WorkspaceTabsContextValue
    render(
      <RoutingHarness
        onContextValue={value => {
          current = value
        }}
      />
    )
    const board = { ...current.activeTab }
    let matchingId = ''
    act(() => {
      matchingId = current.openTab('task', {
        contentRoute: '/runtime-tasks?taskId=completed&deviceId=device',
      }).id
    })
    act(() => current.selectTab(board.id))

    act(() => navigateTo('/runtime-tasks?deviceId=device&taskId=completed'))

    expect(current.activeTabId).toBe(matchingId)
    expect(current.tabs.find(tab => tab.id === board.id)).toEqual(board)
  })

  test('new chat navigation stays in the active task tab without selecting another blank tab', () => {
    let current!: WorkspaceTabsContextValue
    render(
      <RoutingHarness
        onContextValue={value => {
          current = value
        }}
      />
    )
    let taskId = ''
    act(() => {
      taskId = current.openTab('task', {
        contentRoute: '/runtime-tasks?deviceId=device&taskId=completed',
      }).id
    })
    const count = current.tabs.length
    act(() => navigateTo('/'))
    expect(current.activeTabId).toBe(taskId)
    expect(current.activeTab.contentRoute).toBe('/')
    expect(current.tabs).toHaveLength(count)
    expect(new URLSearchParams(window.location.search).has('workspaceTab')).toBe(false)
  })

  test('selects an already open task without replacing the active conversation', () => {
    let current!: WorkspaceTabsContextValue
    render(
      <RoutingHarness
        onContextValue={value => {
          current = value
        }}
      />
    )
    let targetId = ''
    act(() => {
      targetId = current.openTab('task', {
        contentRoute: '/runtime-tasks?taskId=second&deviceId=device',
      }).id
    })
    act(() =>
      current.openTab('task', {
        contentRoute: '/runtime-tasks?deviceId=device&taskId=first',
      })
    )
    const source = { ...current.activeTab }
    const count = current.tabs.length
    act(() => navigateTo('/runtime-tasks?deviceId=device&taskId=second'))
    expect(current.activeTabId).toBe(targetId)
    expect(current.tabs.find(tab => tab.id === source.id)).toEqual(source)
    expect(current.tabs).toHaveLength(count)
  })

  test('registered auxiliary pages replace the task surface in place', async () => {
    await installDshUiTestContributions(
      {
        [WEWORK_DSH_SLOTS.route]: [{ id: 'sites', path: '/sites', telemetryFeature: 'sites' }],
      },
      {}
    )
    let current!: WorkspaceTabsContextValue
    render(
      <RoutingHarness
        onContextValue={value => {
          current = value
        }}
      />
    )
    const originalId = current.activeTabId
    const count = current.tabs.length
    act(() => navigateTo('/sites'))
    expect(current.activeTabId).toBe(originalId)
    expect(current.activeTab.kind).toBe('auxiliary')
    expect(current.tabs).toHaveLength(count)
    act(() => navigateTo('/'))
    expect(current.activeTabId).toBe(originalId)
    expect(current.activeTab.kind).toBe('task')
    expect(current.tabs).toHaveLength(count)
  })

  test.each(['/app/custom', '/app/custom/details', '/custom-native'])(
    'opens registered app destinations without replacing the project space: %s',
    async contentRoute => {
      await installDshUiTestContributions(
        {
          [WEWORK_DSH_SLOTS.app]: [
            { id: 'custom', label: 'Custom', mode: 'iframe' },
            { id: 'custom-native', label: 'Custom native', mode: 'native', path: '/custom-native' },
          ],
        },
        {}
      )
      window.history.replaceState({}, '', '/todo?projectId=one')
      let current!: WorkspaceTabsContextValue
      render(
        <RoutingHarness
          onContextValue={value => {
            current = value
          }}
        />
      )
      const source = { ...current.activeTab }
      act(() => navigateTo(contentRoute))
      expect(current.activeTab.kind).toBe('auxiliary')
      expect(current.activeTab.contentRoute).toBe(contentRoute)
      expect(current.tabs.find(tab => tab.id === source.id)).toEqual(source)
    }
  )
})
