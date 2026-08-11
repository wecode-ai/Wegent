import { act, render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { beforeEach, describe, expect, test } from 'vitest'
import { navigateTo } from '@/lib/navigation'
import { WorkspaceTabsProvider } from './WorkspaceTabsContext'
import { useWorkspaceTabs } from './workspaceTabsContextValue'

const labels = {
  task: '任务',
  board: '项目空间',
  agent: '智能体',
  auxiliary: '工作区',
  auxiliaryRoutes: {
    plugins: '插件',
    sites: '站点',
    automations: '已安排',
    cloud: '云端工作',
  },
}

function TabsState() {
  const { activeTab, openTab, selectTab, tabs } = useWorkspaceTabs()
  const boardTab = tabs.find(tab => tab.kind === 'board')

  return (
    <>
      <div data-testid="tab-count">{tabs.length}</div>
      <div data-testid="active-tab-id">{activeTab.id}</div>
      <div data-testid="active-tab-kind">{activeTab.kind}</div>
      <div data-testid="active-tab-title">{activeTab.title}</div>
      <div data-testid="active-tab-route">{activeTab.contentRoute}</div>
      <button type="button" onClick={() => openTab('board')}>
        新建项目空间标签
      </button>
      <button
        type="button"
        onClick={() =>
          boardTab &&
          selectTab(boardTab.id, {
            title: 'Wegent V4',
            contentRoute: '/todo?projectId=project-1&itemId=WEG-1',
          })
        }
      >
        打开项目任务
      </button>
    </>
  )
}

function RoutingHarness() {
  const [location, setLocation] = useState(() => ({
    pathname: window.location.pathname,
    search: window.location.search,
  }))

  useEffect(() => {
    const updateLocation = () =>
      setLocation({
        pathname: window.location.pathname,
        search: window.location.search,
      })
    window.addEventListener('popstate', updateLocation)
    return () => window.removeEventListener('popstate', updateLocation)
  }, [])

  return (
    <WorkspaceTabsProvider
      pathname={location.pathname}
      search={location.search}
      storageScope="context-test"
      labels={labels}
    >
      <TabsState />
    </WorkspaceTabsProvider>
  )
}

describe('WorkspaceTabsProvider routing', () => {
  beforeEach(() => {
    localStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  test('ordinary navigation replaces the active tab instead of opening another tab', () => {
    render(<RoutingHarness />)
    const originalTabId = screen.getByTestId('active-tab-id').textContent

    act(() => navigateTo('/plugins'))

    expect(screen.getByTestId('tab-count')).toHaveTextContent('3')
    expect(screen.getByTestId('active-tab-id')).toHaveTextContent(originalTabId!)
    expect(screen.getByTestId('active-tab-kind')).toHaveTextContent('auxiliary')
    expect(screen.getByTestId('active-tab-title')).toHaveTextContent('插件')
    expect(screen.getByTestId('active-tab-route')).toHaveTextContent('/plugins')
  })

  test('the explicit new-tab action still opens a separate tab', () => {
    render(<RoutingHarness />)

    act(() => screen.getByRole('button', { name: '新建项目空间标签' }).click())

    expect(screen.getByTestId('tab-count')).toHaveTextContent('4')
    expect(screen.getByTestId('active-tab-kind')).toHaveTextContent('board')
    expect(window.location.search).toContain('workspaceTab=board-')
  })

  test('selects and updates an existing board tab for a concrete project task', () => {
    render(<RoutingHarness />)

    act(() => screen.getByRole('button', { name: '打开项目任务' }).click())

    expect(screen.getByTestId('tab-count')).toHaveTextContent('3')
    expect(screen.getByTestId('active-tab-kind')).toHaveTextContent('board')
    expect(screen.getByTestId('active-tab-title')).toHaveTextContent('Wegent V4')
    expect(screen.getByTestId('active-tab-route')).toHaveTextContent(
      '/todo?projectId=project-1&itemId=WEG-1'
    )
    expect(window.location.search).toContain('projectId=project-1')
    expect(window.location.search).toContain('itemId=WEG-1')
  })
})
