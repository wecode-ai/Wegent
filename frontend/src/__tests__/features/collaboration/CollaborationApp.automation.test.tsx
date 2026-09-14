// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import type {
  CollaborationHostAdapter,
  CollaborationProject,
  SharedWorkspaceApi,
} from '@wegent/collaboration'

import { CollaborationApp } from '@wegent/collaboration'
import { webAutomationUiHost } from '@/features/collaboration/automation/WebAutomationHost'

Object.defineProperty(globalThis.crypto, 'randomUUID', {
  configurable: true,
  value: jest.fn(() => 'automation-test-id'),
})

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

jest.mock('@xyflow/react', () => ({
  Background: () => null,
  BaseEdge: () => null,
  Handle: () => null,
  MiniMap: () => null,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Position: { Left: 'left', Right: 'right' },
  ReactFlow: ({
    children,
    nodes = [],
    nodeTypes = {},
  }: {
    children: React.ReactNode
    nodes?: Array<{
      id: string
      type: string
      data: Record<string, unknown>
    }>
    nodeTypes?: Record<
      string,
      React.ComponentType<{
        id: string
        data: Record<string, unknown>
        selected: boolean
      }>
    >
  }) => (
    <div>
      {nodes.map(node => {
        const Node = nodeTypes[node.type]
        return Node ? <Node key={node.id} id={node.id} data={node.data} selected={false} /> : null
      })}
      {children}
    </div>
  ),
  SelectionMode: { Partial: 'partial' },
  getBezierPath: () => ['', 0, 0],
  useNodesState: (nodes: unknown[]) => [nodes, jest.fn(), jest.fn()],
  useReactFlow: () => ({
    fitView: jest.fn(),
    getViewport: () => ({ x: 0, y: 0, zoom: 0.99 }),
    setViewport: jest.fn(),
    zoomIn: jest.fn(),
    zoomOut: jest.fn(),
  }),
  useStore: () => false,
  useViewport: () => ({ zoom: 0.99 }),
}))

const project: CollaborationProject = {
  id: 'project-1',
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

describe('CollaborationApp shared automation', () => {
  function projectApi(automationOverrides: Record<string, unknown> = {}) {
    return {
      projects: {
        get: jest.fn().mockResolvedValue(project),
        update: jest.fn().mockResolvedValue(project),
        listExecutionEnvironments: jest.fn().mockResolvedValue([]),
      },
      issues: {
        getBoardSnapshot: jest.fn().mockResolvedValue({
          items: [],
          members: [],
          agents: [],
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
      automations: automationOverrides,
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

  it('mounts the shared dispatch-policy view on Web', async () => {
    const listAutomations = jest.fn().mockResolvedValue([])
    const api = projectApi({ list: listAutomations })

    render(
      <CollaborationApp
        api={api}
        host={automationHost()}
        locale="zh-CN"
        pollIntervalMs={0}
        automationUiHost={webAutomationUiHost}
      />
    )

    fireEvent.click(await screen.findByTestId('collaboration-project-settings-dispatch'))
    expect(await screen.findByTestId('project-automation-policy')).toBeInTheDocument()
    await waitFor(() => expect(listAutomations).toHaveBeenCalledWith(project.id))

    fireEvent.click(screen.getByTestId('automation-welcome-create-policy'))

    expect(await screen.findByTestId('automation-policy-name')).toBeInTheDocument()
  })

  it('persists the shared natural-language dispatch policy on Web', async () => {
    const createAutomation = jest.fn().mockImplementation(async (_projectId, input) => ({
      id: 'automation-created',
      projectId: project.id,
      ...input,
      executionEnvironment: input.executionEnvironment ?? 'cloud',
      enabled: true,
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: null,
      version: 1,
      createdAt: '2026-09-11T00:00:00Z',
      updatedAt: '2026-09-11T00:00:00Z',
    }))
    const api = projectApi({
      list: jest.fn().mockResolvedValue([]),
      create: createAutomation,
    })

    render(
      <CollaborationApp
        api={api}
        host={automationHost()}
        locale="zh-CN"
        pollIntervalMs={0}
        automationUiHost={webAutomationUiHost}
      />
    )

    fireEvent.click(await screen.findByTestId('collaboration-project-settings-dispatch'))
    fireEvent.click(await screen.findByTestId('automation-welcome-create-policy'))
    fireEvent.change(screen.getByTestId('automation-policy-name'), {
      target: { value: 'Web dispatch policy' },
    })
    fireEvent.change(screen.getByTestId('automation-coordinator-prompt'), {
      target: { value: 'Inspect pending Issues and create verifiable assignments.' },
    })
    fireEvent.click(screen.getByTestId('automation-save-policy'))

    await waitFor(() =>
      expect(createAutomation).toHaveBeenCalledWith(project.id, expect.anything())
    )
    const savedInput = createAutomation.mock.calls.at(-1)?.[1]
    expect(savedInput).toMatchObject({
      name: 'Web dispatch policy',
    })
    expect(JSON.stringify(savedInput)).toContain(
      'Inspect pending Issues and create verifiable assignments.'
    )
  })
})
