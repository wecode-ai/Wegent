import { describe, expect, test, vi } from 'vitest'
import type { WorkspaceTabsContextValue } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { openIssueReference } from './openIssueReference'

const ISSUE = {
  projectId: '2753648597973755964',
  issueId: 'WEWORK2D8526-113',
}
const ISSUE_ROUTE =
  '/todo?projectStore=backend&projectId=2753648597973755964&itemId=WEWORK2D8526-113'

function workspaceTabs(
  overrides: Partial<WorkspaceTabsContextValue> = {}
): WorkspaceTabsContextValue {
  return {
    tabs: [],
    activeTabId: 'main',
    activeTab: {
      id: 'main',
      kind: 'board',
      title: 'Main',
      fixed: true,
      contentRoute: '/todo?projectStore=backend&projectId=2753648597973755964',
    },
    openTab: vi.fn(),
    selectTab: vi.fn(),
    closeTab: vi.fn(),
    closeOtherTabs: vi.fn(),
    restoreClosedTab: vi.fn(),
    moveTab: vi.fn(),
    updateActiveTab: vi.fn(),
    ...overrides,
  } as WorkspaceTabsContextValue
}

describe('openIssueReference', () => {
  test('selects an existing board tab and points it at the issue', () => {
    const tabs = workspaceTabs({
      tabs: [
        {
          id: 'board-1',
          kind: 'board',
          title: 'weWork需求',
          fixed: false,
          contentRoute: '/todo?projectStore=backend&projectId=2753648597973755964',
        },
      ],
    })

    openIssueReference({
      issue: ISSUE,
      label: 'WEWORK2D8526-113 · 输出框里用at引用对话',
      activeRoute: '/',
      workspaceTabs: tabs,
      navigate: vi.fn(),
    })

    expect(tabs.selectTab).toHaveBeenCalledWith('board-1', {
      title: 'WEWORK2D8526-113 · 输出框里用at引用对话',
      contentRoute: ISSUE_ROUTE,
    })
    expect(tabs.openTab).not.toHaveBeenCalled()
  })

  test('opens a new board tab when the project has no reusable tab', () => {
    const tabs = workspaceTabs()

    openIssueReference({
      issue: ISSUE,
      label: 'Issue title',
      activeRoute: '/',
      workspaceTabs: tabs,
      navigate: vi.fn(),
    })

    expect(tabs.openTab).toHaveBeenCalledWith('board', {
      title: 'Issue title',
      contentRoute: ISSUE_ROUTE,
    })
  })

  test('uses a local board tab to resolve the issue project store', () => {
    const tabs = workspaceTabs({
      tabs: [
        {
          id: 'local-board',
          kind: 'board',
          title: 'Local',
          fixed: true,
          contentRoute: '/todo?projectStore=local&projectId=local-project',
        },
      ],
    })

    openIssueReference({
      issue: { projectId: 'local-project', issueId: 'issue-1' },
      label: 'Local issue',
      activeRoute: '/',
      workspaceTabs: tabs,
      navigate: vi.fn(),
    })

    expect(tabs.openTab).toHaveBeenCalledWith('board', {
      title: 'Local issue',
      contentRoute: '/todo?projectStore=local&projectId=local-project&itemId=issue-1',
    })
  })

  test('falls back to route navigation without workspace tabs', () => {
    const navigate = vi.fn()

    openIssueReference({
      issue: ISSUE,
      activeRoute: '/',
      workspaceTabs: null,
      navigate,
    })

    expect(navigate).toHaveBeenCalledWith(ISSUE_ROUTE)
  })
})
