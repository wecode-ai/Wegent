import { describe, expect, test, vi } from 'vitest'
import {
  closeWorkspaceTab,
  createWorkspaceTab,
  moveWorkspaceTab,
  parseWorkspaceLocation,
  workspaceTabRoute,
} from './workspaceTabs'

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
    apps: '应用',
  },
}

describe('workspaceTabs', () => {
  test('uses the product name until a concrete project supplies its own title', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001')

    expect(createWorkspaceTab('board', labels)).toMatchObject({
      kind: 'board',
      title: '项目空间',
      contentRoute: '/todo',
    })
    expect(
      createWorkspaceTab('board', labels, {
        title: '产品规划',
        contentRoute: '/todo?projectId=project-1',
      })
    ).toMatchObject({
      title: '产品规划',
      contentRoute: '/todo?projectId=project-1',
    })
  })

  test('round-trips tab identity and title without leaking them into content state', () => {
    const tab = createWorkspaceTab('board', labels, {
      id: 'board-1',
      title: '产品规划',
      contentRoute: '/todo?projectId=project-1',
    })
    const route = workspaceTabRoute(tab)

    expect(route).toBe(
      '/todo?projectId=project-1&workspaceTab=board-1&workspaceTabTitle=%E4%BA%A7%E5%93%81%E8%A7%84%E5%88%92'
    )
    expect(parseWorkspaceLocation('/todo', route.slice(route.indexOf('?')))).toEqual({
      contentRoute: '/todo?projectId=project-1',
      tabId: 'board-1',
      tabTitle: '产品规划',
    })
  })

  test('uses localized labels for auxiliary routes', () => {
    expect(createWorkspaceTab('auxiliary', labels, { contentRoute: '/plugins' }).title).toBe('插件')
    expect(createWorkspaceTab('auxiliary', labels, { contentRoute: '/automations' }).title).toBe(
      '已安排'
    )
    expect(createWorkspaceTab('auxiliary', labels, { contentRoute: '/cloud-work' }).title).toBe(
      '云端工作'
    )
  })

  test('moves tabs and selects the nearest survivor when closing the active tab', () => {
    const tabs = [
      createWorkspaceTab('task', labels, { id: 'task-1' }),
      createWorkspaceTab('board', labels, { id: 'board-1' }),
      createWorkspaceTab('agent', labels, { id: 'agent-1' }),
    ]

    expect(moveWorkspaceTab(tabs, 'agent-1', 'task-1').map(tab => tab.id)).toEqual([
      'agent-1',
      'task-1',
      'board-1',
    ])
    expect(
      closeWorkspaceTab(
        tabs,
        'board-1',
        'board-1',
        createWorkspaceTab('task', labels, { id: 'fallback' })
      )
    ).toMatchObject({
      activeTabId: 'agent-1',
      tabs: [{ id: 'task-1' }, { id: 'agent-1' }],
    })
  })
})
