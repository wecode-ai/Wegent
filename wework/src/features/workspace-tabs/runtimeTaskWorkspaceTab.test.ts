import { describe, expect, test, vi } from 'vitest'
import type { WorkspaceTab } from './workspaceTabs'
import type { WorkspaceTabsContextValue } from './workspaceTabsContextValue'
import { openRuntimeTaskWorkspaceTab } from './runtimeTaskWorkspaceTab'

const address = { deviceId: 'device-1', taskId: 'task-1' }
const contentRoute = '/runtime-tasks?deviceId=device-1&taskId=task-1'

function workspaceTabs(tabs: WorkspaceTab[]): WorkspaceTabsContextValue {
  return {
    tabs,
    activeTabId: tabs[0].id,
    activeTab: tabs[0],
    openTab: vi.fn(),
    selectTab: vi.fn(),
    closeTab: vi.fn(),
    closeOtherTabs: vi.fn(),
    restoreClosedTab: vi.fn(),
    moveTab: vi.fn(),
    updateActiveTab: vi.fn(),
  }
}

const taskTab: WorkspaceTab = {
  id: 'task-tab',
  kind: 'task',
  title: '任务',
  contentRoute: '/',
  fixed: true,
}
const boardTab: WorkspaceTab = {
  id: 'board-tab',
  kind: 'board',
  title: '协作',
  contentRoute: '/todo',
  fixed: true,
}

describe('openRuntimeTaskWorkspaceTab', () => {
  test('reuses an existing task tab instead of replacing the active tab', () => {
    const tabs = workspaceTabs([taskTab, boardTab])

    openRuntimeTaskWorkspaceTab(tabs, address)

    expect(tabs.selectTab).toHaveBeenCalledWith(taskTab.id, { contentRoute })
    expect(tabs.openTab).not.toHaveBeenCalled()
    expect(tabs.tabs).toEqual([taskTab, boardTab])
  })

  test('prefers the task tab already showing the requested task', () => {
    const existingTaskTab = { ...taskTab, id: 'task-tab-opened', contentRoute }
    const tabs = workspaceTabs([taskTab, existingTaskTab, boardTab])

    openRuntimeTaskWorkspaceTab(tabs, address)

    expect(tabs.selectTab).toHaveBeenCalledWith(existingTaskTab.id, { contentRoute })
    expect(tabs.openTab).not.toHaveBeenCalled()
  })

  test('creates a task tab when no task tab exists', () => {
    const tabs = workspaceTabs([boardTab])

    openRuntimeTaskWorkspaceTab(tabs, address)

    expect(tabs.openTab).toHaveBeenCalledWith('task', { contentRoute })
    expect(tabs.selectTab).not.toHaveBeenCalled()
  })
})
