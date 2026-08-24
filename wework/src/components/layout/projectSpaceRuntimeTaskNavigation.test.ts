import { describe, expect, test, vi } from 'vitest'
import type { WorkspaceTabsContextValue } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { openProjectSpaceRuntimeTaskInTab } from './projectSpaceRuntimeTaskNavigation'

describe('openProjectSpaceRuntimeTaskInTab', () => {
  test('selects the task tab before opening a full task from a project space', async () => {
    const address = {
      deviceId: 'local-device',
      taskId: 'runtime-1',
    }
    const taskTab = {
      id: 'task-existing',
      kind: 'task' as const,
      title: '任务',
      contentRoute: '/',
      fixed: true,
    }
    const boardTab = {
      id: 'board-existing',
      kind: 'board' as const,
      title: '工作空间',
      contentRoute: '/todo?projectStore=local&projectId=default-work-items',
      fixed: true,
    }
    const callOrder: string[] = []
    const selectTab = vi.fn(() => callOrder.push('select-task-tab'))
    const openRuntimeTask = vi.fn(async () => {
      callOrder.push('open-runtime-task')
    })
    const workspaceTabs = {
      tabs: [taskTab, boardTab],
      activeTabId: boardTab.id,
      activeTab: boardTab,
      openTab: vi.fn(),
      selectTab,
      closeTab: vi.fn(),
      closeOtherTabs: vi.fn(),
      restoreClosedTab: vi.fn(),
      moveTab: vi.fn(),
      updateActiveTab: vi.fn(),
    } as WorkspaceTabsContextValue

    await openProjectSpaceRuntimeTaskInTab(address, workspaceTabs, openRuntimeTask)

    expect(callOrder).toEqual(['select-task-tab', 'open-runtime-task'])
    expect(selectTab).toHaveBeenCalledWith(taskTab.id, {
      contentRoute: '/runtime-tasks?deviceId=local-device&taskId=runtime-1',
    })
    expect(workspaceTabs.tabs).toEqual([taskTab, boardTab])
  })
})
