// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import type {
  CollaborationGroup,
  CollaborationHostAdapter,
  CollaborationProject,
  SharedWorkspaceApi,
} from '@wegent/collaboration'

import { CollaborationApp } from '@wegent/collaboration'
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

jest.mock('@/components/ui/dropdown', () => ({
  DropdownMenu: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode
    onOpenChange?: (open: boolean) => void
  }) => <div onClick={() => onOpenChange?.(true)}>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const project: CollaborationProject = {
  id: 'project-1',
  workspace_id: 'workspace-1',
  public_id: 'AUTO',
  project_key: 'AUTO',
  name: '自动化共享项目',
  description: '',
  project_store: 'backend',
  task_provider: 'native',
  provider_config: {},
  created_by_user_id: 1,
  current_user_id: 1,
  access_role: 'Owner',
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-09-10T00:00:00Z',
  updated_at: '2026-09-10T00:00:00Z',
}

const workspaceGroup: CollaborationGroup = {
  id: 'group-1',
  workspace_id: 'workspace-1',
  owner_type: 'workspace',
  owner_id: 'workspace-1',
  name: '空间交付组',
  description: '',
  leader: { kind: 'agent', id: 'agent-1' },
  members: [{ kind: 'agent', id: 'agent-1' }],
  coordination_mode: 'manager',
  policy: {
    prompt: '持续分配下一个 Issue',
    trigger_type: 'event',
    event_type: 'task.created',
    event_config: {},
    cron_expression: null,
    timezone: 'Asia/Shanghai',
    issue_selector: {},
    output_policy: { mode: 'comment' },
    enabled: true,
  },
  version: 1,
  created_by_user_id: 1,
  created_at: '2026-09-14T00:00:00Z',
  updated_at: '2026-09-14T00:00:00Z',
}

describe('CollaborationApp project collaboration groups', () => {
  function projectApi({
    workspaceGroups = [workspaceGroup],
    projectGroups = [],
    addCollaborationGroup = jest.fn(),
    createCollaborationGroup = jest.fn(),
  }: {
    workspaceGroups?: CollaborationGroup[]
    projectGroups?: CollaborationGroup[]
    addCollaborationGroup?: jest.Mock
    createCollaborationGroup?: jest.Mock
  } = {}) {
    return {
      workspaces: {
        listCollaborationGroups: jest.fn().mockResolvedValue(workspaceGroups),
        listAgents: jest.fn().mockResolvedValue([]),
        listMembers: jest.fn().mockResolvedValue([]),
        listExecutionEnvironments: jest.fn().mockResolvedValue([]),
      },
      resources: {
        list: jest.fn().mockResolvedValue({
          agents: [],
          execution_environments: [],
        }),
      },
      projects: {
        get: jest.fn().mockResolvedValue(project),
        update: jest.fn().mockResolvedValue(project),
        listExecutionEnvironments: jest.fn().mockResolvedValue([]),
        listCollaborationGroups: jest.fn().mockResolvedValue(projectGroups),
        addCollaborationGroup,
        createCollaborationGroup,
        removeCollaborationGroup: jest.fn(),
      },
      issues: {
        getBoardSnapshot: jest.fn().mockResolvedValue({
          items: [],
          members: [],
          agents: [{ id: 'agent-binding-1', team_id: 12, name: '代码智能体' }],
          taskBindings: [],
        }),
        update: jest.fn(),
      },
      members: {
        list: jest.fn().mockResolvedValue([]),
        searchUsers: jest.fn().mockResolvedValue([]),
        add: jest.fn(),
        update: jest.fn(),
        remove: jest.fn(),
      },
      agents: {
        list: jest.fn().mockResolvedValue([]),
      },
      automations: {},
      incomingHooks: {
        catalog: jest.fn().mockResolvedValue([]),
      },
    } as unknown as SharedWorkspaceApi
  }

  function automationHost(): CollaborationHostAdapter {
    return {
      capabilities: {
        automation: true,
        dingtalkAitable: false,
      },
      location: {
        projectId: project.id,
        issueId: null,
        view: 'automation',
      },
      navigate: jest.fn(),
    }
  }

  it('adds a workspace collaboration group to the project', async () => {
    const addCollaborationGroup = jest.fn().mockResolvedValue(workspaceGroup)
    const api = projectApi({ addCollaborationGroup })

    render(<CollaborationApp api={api} host={automationHost()} locale="zh-CN" pollIntervalMs={0} />)

    fireEvent.click(await screen.findByTestId('collaboration-project-settings-dispatch'))
    fireEvent.click(await screen.findByTestId('collaboration-group-add-group-1'))
    await waitFor(() =>
      expect(addCollaborationGroup).toHaveBeenCalledWith(project.id, workspaceGroup.id)
    )
  })

  it('creates a project-owned collaboration group', async () => {
    const createCollaborationGroup = jest.fn().mockImplementation(async (_projectId, input) => ({
      ...workspaceGroup,
      id: 'project-group-1',
      owner_type: 'project',
      owner_id: project.id,
      name: input.name,
    }))
    const api = projectApi({
      workspaceGroups: [],
      createCollaborationGroup,
    })

    render(<CollaborationApp api={api} host={automationHost()} locale="zh-CN" pollIntervalMs={0} />)

    fireEvent.click(await screen.findByTestId('collaboration-project-settings-dispatch'))
    fireEvent.click(await screen.findByTestId('collaboration-group-open-create'))
    fireEvent.change(await screen.findByTestId('collaboration-group-name'), {
      target: { value: '项目交付组' },
    })
    fireEvent.click(screen.getByLabelText('代码智能体'))
    fireEvent.change(screen.getByTestId('collaboration-group-leader'), {
      target: { value: 'agent:12' },
    })
    fireEvent.change(screen.getByTestId('collaboration-group-prompt'), {
      target: { value: '检查待办并持续分配下一个 Issue' },
    })
    fireEvent.click(screen.getByTestId('collaboration-group-create'))

    await waitFor(() =>
      expect(createCollaborationGroup).toHaveBeenCalledWith(project.id, expect.anything())
    )
    const savedInput = createCollaborationGroup.mock.calls.at(-1)?.[1]
    expect(savedInput).toMatchObject({
      name: '项目交付组',
      leader: { kind: 'agent', id: '12' },
      members: [{ kind: 'agent', id: '12' }],
    })
    expect(savedInput.policy.prompt).toBe('检查待办并持续分配下一个 Issue')
  })
})
