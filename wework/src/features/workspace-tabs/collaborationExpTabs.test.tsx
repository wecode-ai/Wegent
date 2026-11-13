import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, test } from 'vitest'
import { navigateTo } from '@/lib/navigation'
import {
  COLLABORATION_EXP_PATH,
  COLLABORATION_EXP_TAB_ID,
} from '@/features/collaboration-exp/collaborationExpFeature'
import type { WorkspaceTabsContextValue } from './workspaceTabsContextValue'
import { RoutingHarness } from './workspaceTabsTestHarness'
import { labels } from './workspaceTabsTestLabels'
import { createWorkspaceTab, workspaceTabsStorageKey } from './workspaceTabs'

const experimentLabels = {
  ...labels,
  auxiliaryRoutes: { ...labels.auxiliaryRoutes, [COLLABORATION_EXP_PATH]: '协作 exp' },
}

describe('collaboration experiment workspace tab', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  test('uses its canonical auxiliary identity for an explicitly addressed startup link', () => {
    window.history.replaceState({}, '', '/collaboration-exp?projectId=one&workspaceTab=foreign')
    let current!: WorkspaceTabsContextValue
    render(
      <RoutingHarness
        labels={experimentLabels}
        onContextValue={value => {
          current = value
        }}
      />
    )
    expect(current.activeTab.id).toBe(COLLABORATION_EXP_TAB_ID)
    expect(current.activeTab.kind).toBe('auxiliary')
    expect(current.activeTab.contentRoute).toBe('/collaboration-exp?projectId=one')
  })

  test('opens a dedicated auxiliary tab and reuses it across deep links', () => {
    let current!: WorkspaceTabsContextValue
    render(
      <RoutingHarness
        labels={experimentLabels}
        onContextValue={value => {
          current = value
        }}
      />
    )
    const originalTabs = current.tabs.map(tab => ({ ...tab }))

    act(() => navigateTo('/collaboration-exp?projectId=one&issueId=first'))

    expect(current.activeTab.id).toBe(COLLABORATION_EXP_TAB_ID)
    expect(current.activeTab.kind).toBe('auxiliary')
    expect(current.activeTab.title).toBe('协作 exp')
    expect(current.activeTab.contentRoute).toBe('/collaboration-exp?projectId=one&issueId=first')
    for (const original of originalTabs)
      expect(current.tabs.find(tab => tab.id === original.id)).toEqual(original)

    act(() => current.selectTab(originalTabs[0].id))
    act(() => navigateTo('/collaboration-exp?projectId=two&issueId=second'))

    expect(current.activeTab.id).toBe(COLLABORATION_EXP_TAB_ID)
    expect(current.activeTab.contentRoute).toBe('/collaboration-exp?projectId=two&issueId=second')
    expect(
      current.tabs.filter(tab => tab.contentRoute.startsWith(COLLABORATION_EXP_PATH))
    ).toHaveLength(1)
    expect(current.tabs.find(tab => tab.kind === 'board')?.contentRoute).toBe('/todo')
  })

  test('reopening the bare experiment entry preserves its selected task, filters and discussion', () => {
    let current!: WorkspaceTabsContextValue
    render(
      <RoutingHarness
        labels={experimentLabels}
        onContextValue={value => {
          current = value
        }}
      />
    )
    const route =
      '/collaboration-exp?view=tasks&projectStore=local&projectId=one&issueId=first&search=release&discussion=owned&future=keep'
    act(() => navigateTo(route))
    const originalId = current.activeTab.id
    const task = current.tabs.find(tab => tab.kind === 'task')!
    act(() => current.selectTab(task.id))
    act(() => {
      current.openTab('auxiliary', { contentRoute: COLLABORATION_EXP_PATH })
    })
    expect(current.activeTab.id).toBe(originalId)
    expect(current.activeTab.contentRoute).toBe(route)
    act(() => navigateTo(COLLABORATION_EXP_PATH))
    expect(current.activeTab.contentRoute).toBe(route)
    act(() => navigateTo('/collaboration-exp?projectStore=backend&projectId=two&issueId=second'))
    expect(current.activeTab.id).toBe(originalId)
    expect(current.activeTab.contentRoute).toBe(
      '/collaboration-exp?projectStore=backend&projectId=two&issueId=second'
    )
    expect(
      current.tabs.filter(tab => tab.contentRoute.startsWith(COLLABORATION_EXP_PATH))
    ).toHaveLength(1)
  })

  test('hides a disabled experiment without deleting its persisted fixed tab or query', () => {
    const task = createWorkspaceTab('task', experimentLabels, { id: 'fixed-task', fixed: true })
    const board = createWorkspaceTab('board', experimentLabels, { id: 'fixed-board', fixed: true })
    const experiment = createWorkspaceTab('auxiliary', experimentLabels, {
      contentRoute: '/collaboration-exp?projectId=one&issueId=first',
      fixed: true,
    })
    const fixedTabs = [task, board, experiment]
    let current!: WorkspaceTabsContextValue
    const onContextValue = (value: WorkspaceTabsContextValue) => {
      current = value
    }
    const { rerender } = render(
      <RoutingHarness
        labels={experimentLabels}
        fixedTabs={fixedTabs}
        hiddenTabPaths={[COLLABORATION_EXP_PATH]}
        onContextValue={onContextValue}
      />
    )

    expect(current.tabs).toEqual([task, board])
    const stored = JSON.parse(localStorage.getItem(workspaceTabsStorageKey('context-test'))!)
    expect(stored.tabs).toContainEqual(experiment)
    act(() => navigateTo('/collaboration-exp?projectId=other'))
    expect(current.tabs).toEqual([task, board])
    expect(window.location.pathname).toBe('/')

    rerender(
      <RoutingHarness
        labels={experimentLabels}
        fixedTabs={fixedTabs}
        onContextValue={onContextValue}
      />
    )

    expect(current.tabs).toContainEqual(experiment)
    act(() => current.selectTab(experiment.id))
    expect(current.activeTab.contentRoute).toBe(experiment.contentRoute)
  })

  test('restores a disabled active experiment to a usable existing tab', () => {
    const task = createWorkspaceTab('task', experimentLabels, { id: 'fixed-task', fixed: true })
    const experiment = createWorkspaceTab('auxiliary', experimentLabels, {
      contentRoute: '/collaboration-exp?projectId=one',
      fixed: true,
    })
    localStorage.setItem(
      workspaceTabsStorageKey('context-test'),
      JSON.stringify({ tabs: [task, experiment], activeTabId: experiment.id })
    )
    window.history.replaceState({}, '', experiment.contentRoute)
    let current!: WorkspaceTabsContextValue
    render(
      <RoutingHarness
        labels={experimentLabels}
        fixedTabs={[task, experiment]}
        hiddenTabPaths={[COLLABORATION_EXP_PATH]}
        onContextValue={value => {
          current = value
        }}
      />
    )

    expect(current.activeTabId).toBe(task.id)
    expect(current.tabs).toEqual([task])
    expect(window.location.pathname).toBe('/')
    const stored = JSON.parse(localStorage.getItem(workspaceTabsStorageKey('context-test'))!)
    expect(stored.tabs).toContainEqual(experiment)
  })

  test('does not create a persisted experiment from a disabled startup deep link', () => {
    window.history.replaceState({}, '', '/collaboration-exp?projectId=one')
    let current!: WorkspaceTabsContextValue
    render(
      <RoutingHarness
        labels={experimentLabels}
        hiddenTabPaths={[COLLABORATION_EXP_PATH]}
        onContextValue={value => {
          current = value
        }}
      />
    )
    expect(current.tabs.some(tab => tab.id === COLLABORATION_EXP_TAB_ID)).toBe(false)
    expect(
      JSON.parse(localStorage.getItem(workspaceTabsStorageKey('context-test'))!).tabs.some(
        (tab: { id: string }) => tab.id === COLLABORATION_EXP_TAB_ID
      )
    ).toBe(false)
    expect(window.location.pathname).toBe('/')
  })

  test('retains a hidden ordinary experiment when closing other visible tabs', () => {
    const task = createWorkspaceTab('task', experimentLabels, { id: 'task' })
    const board = createWorkspaceTab('board', experimentLabels, { id: 'board' })
    const experiment = createWorkspaceTab('auxiliary', experimentLabels, {
      contentRoute: '/collaboration-exp?projectId=one',
    })
    localStorage.setItem(
      workspaceTabsStorageKey('context-test'),
      JSON.stringify({ tabs: [task, board, experiment], activeTabId: task.id })
    )
    let current!: WorkspaceTabsContextValue
    render(
      <RoutingHarness
        labels={experimentLabels}
        hiddenTabPaths={[COLLABORATION_EXP_PATH]}
        onContextValue={value => {
          current = value
        }}
      />
    )
    act(() => current.closeOtherTabs(task.id))
    expect(current.tabs).toEqual([task])
    expect(
      JSON.parse(localStorage.getItem(workspaceTabsStorageKey('context-test'))!).tabs
    ).toContainEqual(experiment)
  })

  test('restores a closed experiment by reusing a reopened singleton', () => {
    let current!: WorkspaceTabsContextValue
    render(
      <RoutingHarness
        labels={experimentLabels}
        onContextValue={value => {
          current = value
        }}
      />
    )
    act(() => navigateTo('/collaboration-exp?projectId=one'))
    act(() => current.closeTab(COLLABORATION_EXP_TAB_ID))
    act(() => navigateTo('/collaboration-exp?projectId=two'))
    act(() => current.restoreClosedTab())
    expect(
      current.tabs.filter(tab => tab.contentRoute.startsWith(COLLABORATION_EXP_PATH))
    ).toHaveLength(1)
    expect(current.activeTab.contentRoute).toBe('/collaboration-exp?projectId=two')
  })

  test('restores only retained experiment state across main-window instances and a disabled restart', () => {
    const task = createWorkspaceTab('task', experimentLabels, { id: 'fixed-task', fixed: true })
    const experiment = createWorkspaceTab('auxiliary', experimentLabels, {
      contentRoute: COLLABORATION_EXP_PATH,
      fixed: true,
    })
    const stale = createWorkspaceTab('board', experimentLabels, {
      id: 'old-board',
      title: 'Preserve old record',
      contentRoute: '/todo?projectId=stale',
    })
    localStorage.setItem(
      workspaceTabsStorageKey('context-test'),
      JSON.stringify({ tabs: [stale], activeTabId: stale.id })
    )
    const route =
      '/collaboration-exp?view=tasks&projectStore=local&projectId=one&issueId=first&discussion=private'
    let current!: WorkspaceTabsContextValue
    const onContextValue = (value: WorkspaceTabsContextValue) => {
      current = value
    }
    const props = {
      labels: experimentLabels,
      fixedTabs: [task, experiment],
      restoreSessionTabs: false,
      retainedTabPaths: [COLLABORATION_EXP_PATH],
      onContextValue,
    }
    const first = render(<RoutingHarness {...props} />)
    act(() => navigateTo(route))
    expect(current.tabs.some(tab => tab.id === stale.id)).toBe(false)
    first.unmount()

    window.history.replaceState({}, '', '/')
    const disabled = render(<RoutingHarness {...props} hiddenTabPaths={[COLLABORATION_EXP_PATH]} />)
    expect(current.tabs).toEqual([task])
    expect(
      JSON.parse(localStorage.getItem(workspaceTabsStorageKey('context-test'))!).tabs
    ).toContainEqual(stale)
    disabled.unmount()

    const reopened = render(<RoutingHarness {...props} />)
    expect(current.tabs.find(tab => tab.id === experiment.id)?.contentRoute).toBe(route)
    expect(current.tabs.some(tab => tab.id === stale.id)).toBe(false)
    act(() => current.selectTab(experiment.id))
    expect(current.activeTab.contentRoute).toBe(route)
    reopened.unmount()
  })

  test('does not rewrite old main-window storage without any retained experiment', () => {
    const stale = createWorkspaceTab('board', experimentLabels, {
      id: 'old-board',
      title: 'Preserve old record',
      contentRoute: '/todo?projectId=stale',
    })
    const stored = JSON.stringify({ tabs: [stale], activeTabId: stale.id })
    localStorage.setItem(workspaceTabsStorageKey('context-test'), stored)
    render(
      <RoutingHarness
        labels={experimentLabels}
        restoreSessionTabs={false}
        retainedTabPaths={[COLLABORATION_EXP_PATH]}
        hiddenTabPaths={[COLLABORATION_EXP_PATH]}
      />
    )
    expect(localStorage.getItem(workspaceTabsStorageKey('context-test'))).toBe(stored)
  })
})
