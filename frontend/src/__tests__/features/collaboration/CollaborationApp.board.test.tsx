// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import {
  CollaborationApp,
  type CollaborationHostAdapter,
  type CollaborationIssue,
  type CollaborationProject,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'

const statuses = [
  { id: 'inbox', name: '收集箱', color: 'gray' as const },
  { id: 'pending', name: '待开始', color: 'blue' as const },
  { id: 'in_progress', name: '进行中', color: 'orange' as const },
  { id: 'in_review', name: '待确认', color: 'purple' as const },
  { id: 'completed', name: '已完成', color: 'green' as const },
]

type GroupBy = 'status' | 'priority' | 'assignee' | 'tag'

function project(groupBy: GroupBy = 'status'): CollaborationProject {
  return {
    id: 'project-1',
    public_id: 'WEB',
    project_key: 'WEB',
    name: 'Web 协作项目',
    description: '共享项目壳与看板',
    project_store: 'backend',
    task_provider: 'native',
    provider_config: {},
    access_role: 'Owner',
    board_config: {
      group_by: groupBy,
      processing_start_status_id: 'in_progress',
      statuses,
    },
    card_display: {
      show_assignee: true,
      show_priority: true,
      show_tags: true,
      show_date: true,
    },
    created_by_user_id: 1,
    status: 'active',
    tags: ['后端'],
    version: 1,
    created_at: '2026-09-10T00:00:00Z',
    updated_at: '2026-09-10T00:00:00Z',
  }
}

function issue(): CollaborationIssue {
  return {
    id: 'issue-1',
    cloud_project_id: 'project-1',
    sequence_number: 1,
    parent_id: null,
    created_by_user_id: 1,
    assignee_user_id: 1,
    assignee_name: '协作者',
    title: '共享看板任务',
    description: '只能由共享看板渲染',
    status: 'pending',
    priority: 'high',
    due_at: null,
    tags: ['共享'],
    sort_order: 0,
    version: 1,
    created_at: '2026-09-10T00:00:00Z',
    updated_at: '2026-09-10T00:00:00Z',
    completed_at: null,
    can_edit: true,
  }
}

function dragDataTransfer() {
  const transfer = new Map<string, string>()
  return {
    effectAllowed: 'none',
    getData: (type: string) => transfer.get(type) ?? '',
    setData: (type: string, value: string) => transfer.set(type, value),
  }
}

describe('CollaborationApp shared project board', () => {
  it('renders the shared project shell and five-column board with real API state', async () => {
    const currentProject = project()
    const updateProject = jest.fn().mockResolvedValue(project('priority'))
    const updateIssue = jest.fn().mockResolvedValue({ ...issue(), status: 'completed', version: 2 })
    const reorderIssue = jest
      .fn()
      .mockResolvedValue([{ ...issue(), status: 'completed', version: 2 }])
    const api = {
      projects: {
        get: jest.fn().mockResolvedValue(currentProject),
        update: updateProject,
      },
      issues: {
        getBoardSnapshot: jest.fn().mockResolvedValue({
          items: [issue()],
          members: [],
        }),
        update: updateIssue,
        reorder: reorderIssue,
      },
    } as unknown as SharedWorkspaceApi
    const host: CollaborationHostAdapter = {
      capabilities: {
        automation: true,
        dingtalkAitable: false,
      },
      location: {
        projectId: currentProject.id,
        issueId: null,
        view: 'board',
      },
      navigate: jest.fn(),
    }

    render(<CollaborationApp api={api} host={host} locale="zh-CN" pollIntervalMs={0} />)

    expect(await screen.findByTestId('cloud-project-header')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-header-title')).toHaveTextContent('Web 协作项目')
    expect(screen.getByTestId('cloud-board-toolbar')).toBeInTheDocument()
    for (const status of statuses) {
      expect(screen.getByTestId(`cloud-todo-column-${status.id}`)).toBeInTheDocument()
    }
    expect(screen.getByTestId('collaboration-issue-issue-1')).toHaveTextContent('共享看板任务')

    const dataTransfer = dragDataTransfer()
    fireEvent.dragStart(screen.getByTestId('collaboration-issue-issue-1'), { dataTransfer })
    fireEvent.drop(screen.getByTestId('cloud-todo-column-dropzone-completed'), { dataTransfer })
    await waitFor(() =>
      expect(updateIssue).toHaveBeenCalledWith('issue-1', {
        version: 1,
        status: 'completed',
      })
    )
    await waitFor(() =>
      expect(reorderIssue).toHaveBeenCalledWith(currentProject.id, {
        parentId: null,
        status: 'completed',
        issueIds: ['issue-1'],
      })
    )
    expect(updateIssue.mock.invocationCallOrder[0]).toBeLessThan(
      reorderIssue.mock.invocationCallOrder[0]
    )

    fireEvent.change(screen.getByTestId('cloud-board-search'), {
      target: { value: '不存在的任务' },
    })
    expect(screen.queryByTestId('collaboration-issue-issue-1')).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('cloud-board-group-by'), {
      target: { value: 'priority' },
    })
    await waitFor(() =>
      expect(updateProject).toHaveBeenCalledWith(
        currentProject.id,
        expect.objectContaining({
          version: currentProject.version,
          boardConfig: expect.objectContaining({ group_by: 'priority' }),
        })
      )
    )
  })

  it.each([
    {
      groupBy: 'priority' as const,
      target: 'cloud-todo-column-dropzone-priority-urgent',
      configure: (api: { update: jest.Mock; assign: jest.Mock; reorder: jest.Mock }) => ({
        assert: () =>
          expect(api.update).toHaveBeenCalledWith('issue-1', {
            version: 1,
            priority: 'urgent',
          }),
      }),
    },
    {
      groupBy: 'assignee' as const,
      target: 'cloud-todo-column-dropzone-assignee-2',
      configure: (api: { update: jest.Mock; assign: jest.Mock; reorder: jest.Mock }) => ({
        assert: () =>
          expect(api.assign).toHaveBeenCalledWith('project-1', 'issue-1', {
            version: 1,
            assigneeType: 'user',
            assigneeId: '2',
            notifyAssignee: true,
          }),
      }),
    },
    {
      groupBy: 'tag' as const,
      target: 'cloud-todo-column-dropzone-tag-后端',
      configure: (api: { update: jest.Mock; assign: jest.Mock; reorder: jest.Mock }) => ({
        assert: () =>
          expect(api.update).toHaveBeenCalledWith('issue-1', {
            version: 1,
            tags: ['后端'],
          }),
      }),
    },
  ])('persists $groupBy drops through the shared mutation model', async scenario => {
    const currentProject = project(scenario.groupBy)
    const update = jest.fn().mockImplementation(async (_id, input) => ({
      ...issue(),
      priority: input.priority ?? issue().priority,
      tags: input.tags ?? issue().tags,
    }))
    const assign = jest.fn().mockResolvedValue({
      ...issue(),
      assignee_user_id: 2,
      assignee_name: '第二位协作者',
    })
    const reorder = jest.fn()
    const api = {
      projects: {
        get: jest.fn().mockResolvedValue(currentProject),
      },
      issues: {
        getBoardSnapshot: jest.fn().mockResolvedValue({
          items: [issue()],
          members: [
            {
              id: 2,
              user_id: 2,
              user_name: '第二位协作者',
              email: null,
              role: 'Member',
            },
          ],
          agents: [],
          taskBindings: [],
        }),
        update,
        assign,
        reorder,
      },
    } as unknown as SharedWorkspaceApi
    const host: CollaborationHostAdapter = {
      capabilities: {
        automation: true,
        dingtalkAitable: false,
      },
      location: {
        projectId: currentProject.id,
        issueId: null,
        view: 'board',
      },
      navigate: jest.fn(),
    }

    render(<CollaborationApp api={api} host={host} locale="zh-CN" pollIntervalMs={0} />)

    const card = await screen.findByTestId('collaboration-issue-issue-1')
    const dataTransfer = dragDataTransfer()
    fireEvent.dragStart(card, { dataTransfer })
    fireEvent.drop(screen.getByTestId(scenario.target), { dataTransfer })

    const assertion = scenario.configure({ update, assign, reorder })
    await waitFor(assertion.assert)
  })

  it('loads and renders all paged GitHub board statuses through the shared API', async () => {
    const externalProject = {
      ...project(),
      task_provider: 'github' as const,
    }
    const pendingIssue = {
      ...issue(),
      id: 'github-pending-1',
      status: 'pending',
      title: 'GitHub 第一页 Issue',
    }
    const nextPendingIssue = {
      ...issue(),
      id: 'github-pending-2',
      status: 'pending',
      title: 'GitHub 第二页 Issue',
    }
    const completedIssue = {
      ...issue(),
      id: 'github-completed-1',
      status: 'completed',
      title: 'GitHub 已完成 Issue',
    }
    const listPage = jest.fn(
      async (_projectId: string, input: { status: string; cursor?: string | null }) => {
        if (input.status === 'pending' && !input.cursor) {
          return {
            items: [pendingIssue],
            nextCursor: 'pending-page-2',
            taskBindings: [],
          }
        }
        if (input.status === 'pending' && input.cursor === 'pending-page-2') {
          return {
            items: [nextPendingIssue],
            nextCursor: null,
            taskBindings: [],
          }
        }
        if (input.status === 'completed') {
          return {
            items: [completedIssue],
            nextCursor: null,
            taskBindings: [],
          }
        }
        return { items: [], nextCursor: null, taskBindings: [] }
      }
    )
    const api = {
      projects: {
        list: jest.fn().mockResolvedValue([externalProject]),
        get: jest.fn().mockResolvedValue(externalProject),
      },
      issues: {
        listPage,
        getBoardSnapshot: jest.fn(),
      },
      members: {
        list: jest.fn().mockResolvedValue([]),
      },
      agents: {
        list: jest.fn().mockResolvedValue([]),
      },
    } as unknown as SharedWorkspaceApi
    const host: CollaborationHostAdapter = {
      capabilities: {
        automation: true,
        dingtalkAitable: false,
      },
      location: {
        projectId: externalProject.id,
        issueId: null,
        view: 'board',
      },
      navigate: jest.fn(),
    }

    render(<CollaborationApp api={api} host={host} locale="zh-CN" pollIntervalMs={0} />)

    expect(await screen.findByText('GitHub 第一页 Issue')).toBeInTheDocument()
    expect(screen.getByText('GitHub 第二页 Issue')).toBeInTheDocument()
    expect(screen.getByText('GitHub 已完成 Issue')).toBeInTheDocument()
    expect(listPage).toHaveBeenCalledTimes(6)
    expect(listPage).toHaveBeenCalledWith(externalProject.id, {
      status: 'inbox',
      parentId: null,
      cursor: null,
      limit: 100,
    })
    expect(listPage).toHaveBeenCalledWith(externalProject.id, {
      status: 'pending',
      parentId: null,
      cursor: 'pending-page-2',
      limit: 100,
    })
    expect(api.issues.getBoardSnapshot).not.toHaveBeenCalled()
  })
})
