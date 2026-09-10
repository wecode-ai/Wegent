// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import {
  CollaborationApp,
  type CollaborationHostAdapter,
  type SharedWorkspaceApi,
  type WorkspaceMyWorkItem,
} from '@wegent/collaboration'

function myWorkItem(): WorkspaceMyWorkItem {
  return {
    id: 'issue-1',
    cloud_project_id: 'project-1',
    sequence_number: 1,
    parent_id: null,
    created_by_user_id: 1,
    assignee_user_id: 1,
    title: '真实接口任务',
    description: '',
    status: 'pending',
    priority: 'high',
    due_at: null,
    tags: [],
    sort_order: 0,
    version: 1,
    created_at: '2026-09-10T00:00:00Z',
    updated_at: '2026-09-10T00:00:00Z',
    completed_at: null,
    project_key: 'WEB',
    project_name: 'Web 项目',
    has_active_task: false,
  }
}

describe('CollaborationApp My Work root', () => {
  it('loads listMyWork directly and uses the shared grouped view', async () => {
    const listMyWork = jest.fn().mockResolvedValue([myWorkItem()])
    const listProjects = jest.fn()
    const getBoardSnapshot = jest.fn()
    const navigate = jest.fn()
    const api = {
      projects: { listMyWork, list: listProjects },
      issues: { getBoardSnapshot },
    } as unknown as SharedWorkspaceApi
    const host: CollaborationHostAdapter = {
      capabilities: {
        cloudProjects: true,
        localProjects: false,
        aiAssignment: true,
        automation: true,
        terminal: false,
        dingtalkAitable: false,
      },
      location: {
        projectId: null,
        issueId: null,
        view: 'board',
        rootView: 'my-work',
      },
      navigate,
    }

    render(<CollaborationApp api={api} host={host} locale="zh-CN" />)

    expect(await screen.findByTestId('my-work-groups')).toBeInTheDocument()
    expect(screen.getByTestId('my-work-group-action-issue-1')).toHaveTextContent('真实接口任务')
    expect(screen.getByTestId('my-work-view-tab-group')).toHaveAttribute('aria-selected', 'true')
    expect(listMyWork).toHaveBeenCalledTimes(1)
    expect(listProjects).not.toHaveBeenCalled()
    expect(getBoardSnapshot).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('my-work-group-action-issue-1'))
    expect(navigate).toHaveBeenCalledWith({
      projectId: 'project-1',
      issueId: 'issue-1',
      view: 'board',
    })

    fireEvent.click(screen.getByTestId('collaboration-my-work-back'))
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        projectId: null,
        issueId: null,
        view: 'board',
        rootView: 'home',
      })
    )
  })
})
