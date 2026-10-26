import { useEffect, useRef, useState } from 'react'
import { WorkspaceTabsProvider } from './WorkspaceTabsContext'
import {
  useOptionalWorkspaceTabActivity,
  useWorkspaceTabs,
  type WorkspaceTabActivity,
  type WorkspaceTabsContextValue,
} from './workspaceTabsContextValue'

import { labels } from './workspaceTabsTestLabels'

function TabsState() {
  const { activeTab, closeTab, openTab, selectTab, tabs, updateActiveTab } = useWorkspaceTabs()
  const boardTab = tabs.find(tab => tab.kind === 'board')
  const backgroundTabIdRef = useRef<string | null>(null)
  const capturedCloseTabRef = useRef<typeof closeTab | null>(null)

  return (
    <>
      <div data-testid="tab-count">{tabs.length}</div>
      <div data-testid="active-tab-id">{activeTab.id}</div>
      <div data-testid="active-tab-kind">{activeTab.kind}</div>
      <div data-testid="active-tab-title">{activeTab.title}</div>
      <div data-testid="active-tab-route">{activeTab.contentRoute}</div>
      <div data-testid="board-tab-title">{boardTab?.title}</div>
      <div data-testid="tab-ids">{tabs.map(tab => tab.id).join(',')}</div>
      <div data-testid="fixed-tab-count">{tabs.filter(tab => tab.fixed).length}</div>
      <button type="button" onClick={() => openTab('board')}>
        新建项目空间标签
      </button>
      <button type="button" onClick={() => closeTab(activeTab.id)}>
        关闭当前标签
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
      <button
        type="button"
        onClick={() => updateActiveTab({ contentRoute: '/sites?app_type=smart_app' })}
      >
        打开智能工作台市场
      </button>
      <button
        type="button"
        onClick={() => {
          const tab = openTab('auxiliary', {
            title: '后台智能工作台',
            contentRoute: '/app/harness-background',
          })
          backgroundTabIdRef.current = tab.id
        }}
      >
        打开后台智能工作台
      </button>
      <button
        type="button"
        onClick={() => {
          const applicationsTab = tabs.find(tab => tab.contentRoute.startsWith('/sites?'))
          if (applicationsTab) selectTab(applicationsTab.id)
        }}
      >
        返回智能工作台列表
      </button>
      <button
        type="button"
        onClick={() => {
          capturedCloseTabRef.current = closeTab
        }}
      >
        开始异步关闭
      </button>
      <button
        type="button"
        onClick={() => {
          if (backgroundTabIdRef.current) {
            capturedCloseTabRef.current?.(backgroundTabIdRef.current)
          }
        }}
      >
        完成异步关闭
      </button>
    </>
  )
}

function ContextValueProbe({ onChange }: { onChange: (value: WorkspaceTabsContextValue) => void }) {
  const value = useWorkspaceTabs()
  useEffect(() => onChange(value), [onChange, value])
  return null
}

function ActivityProbe({ onRead }: { onRead: (isActive: WorkspaceTabActivity | null) => void }) {
  const isActive = useOptionalWorkspaceTabActivity()
  useEffect(() => onRead(isActive), [isActive, onRead])
  return null
}

export function RoutingHarness({
  startupTabKind,
  startupTabId,
  fixedTabs,
  restoreSessionTabs,
  labels: routingLabels = labels,
  onContextValue,
  onActivity,
}: {
  startupTabKind?: 'task' | 'board' | 'agent'
  startupTabId?: string
  fixedTabs?: Parameters<typeof WorkspaceTabsProvider>[0]['fixedTabs']
  restoreSessionTabs?: boolean
  labels?: Parameters<typeof WorkspaceTabsProvider>[0]['labels']
  onContextValue?: (value: WorkspaceTabsContextValue) => void
  onActivity?: (isActive: WorkspaceTabActivity | null) => void
} = {}) {
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
      labels={routingLabels}
      fixedTabs={fixedTabs}
      startupTabId={startupTabId}
      startupTabKind={startupTabKind}
      restoreSessionTabs={restoreSessionTabs}
    >
      <TabsState />
      {onContextValue && <ContextValueProbe onChange={onContextValue} />}
      {onActivity && <ActivityProbe onRead={onActivity} />}
    </WorkspaceTabsProvider>
  )
}
