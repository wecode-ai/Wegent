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
  it('mounts the shared rules view and shared workflow canvas on Web', async () => {
    const listAutomations = jest.fn().mockResolvedValue([])
    const api = {
      projects: {
        get: jest.fn().mockResolvedValue(project),
        update: jest.fn().mockResolvedValue(project),
      },
      issues: {
        getBoardSnapshot: jest.fn().mockResolvedValue({
          items: [],
          members: [],
          agents: [],
          taskBindings: [],
        }),
      },
      automations: {
        list: listAutomations,
      },
      incomingHooks: {
        catalog: jest.fn().mockResolvedValue([]),
      },
    } as unknown as SharedWorkspaceApi
    const host: CollaborationHostAdapter = {
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

    render(
      <CollaborationApp
        api={api}
        host={host}
        locale="zh-CN"
        pollIntervalMs={0}
        automationUiHost={webAutomationUiHost}
      />
    )

    expect(await screen.findByTestId('automation-create-rule')).toBeInTheDocument()
    await waitFor(() => expect(listAutomations).toHaveBeenCalledWith(project.id))

    fireEvent.click(screen.getByTestId('automation-create-rule'))

    expect(await screen.findByTestId('automation-workflow-canvas')).toBeInTheDocument()
  })

  it('selects and persists Web runtime, model, and plugin settings through shared UI', async () => {
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
    const loadCatalog = jest.fn().mockResolvedValue({
      environments: [
        {
          deviceId: 'device-cloud',
          label: 'Cloud Runner',
          executionEnvironment: 'cloud',
        },
      ],
      models: [
        {
          name: 'gpt-web',
          label: 'GPT Web',
          type: 'public',
          options: { reasoning_effort: 'high' },
        },
      ],
      runtimeProfiles: [
        {
          id: 'profile-cloud',
          name: 'Cloud GPT',
          executionEnvironment: 'cloud',
          executionDeviceId: 'device-cloud',
          model: 'gpt-web',
          modelType: 'public',
          modelOptions: { reasoning_effort: 'medium' },
          status: 'active',
          version: 1,
        },
      ],
      plugins: [],
    })
    const loadPlugins = jest.fn().mockResolvedValue([
      {
        id: 'plugin-github',
        label: 'GitHub',
        reference: {
          id: 'plugin-github',
          pluginName: 'github',
          marketplaceId: 'official',
          displayName: 'GitHub',
        },
      },
    ])
    const api = {
      projects: {
        get: jest.fn().mockResolvedValue(project),
        update: jest.fn().mockResolvedValue(project),
      },
      issues: {
        getBoardSnapshot: jest.fn().mockResolvedValue({
          items: [],
          members: [],
          agents: [],
          taskBindings: [],
        }),
      },
      automations: {
        list: jest.fn().mockResolvedValue([]),
        create: createAutomation,
      },
      incomingHooks: {
        catalog: jest.fn().mockResolvedValue([]),
      },
      automationExecutionCatalog: {
        load: loadCatalog,
        loadPlugins,
      },
    } as unknown as SharedWorkspaceApi
    const host: CollaborationHostAdapter = {
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

    render(
      <CollaborationApp
        api={api}
        host={host}
        locale="zh-CN"
        pollIntervalMs={0}
        automationUiHost={webAutomationUiHost}
      />
    )

    fireEvent.click(await screen.findByTestId('automation-create-rule'))
    await waitFor(() => expect(loadCatalog).toHaveBeenCalledWith(project.id))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-trigger'))
    fireEvent.click(screen.getByTestId('automation-node-insert-after-task-trigger'))
    fireEvent.change(await screen.findByTestId(/^execution-node-name-step-/), {
      target: { value: 'Cloud execution' },
    })
    fireEvent.change(screen.getByTestId(/^execution-node-prompt-step-/), {
      target: { value: 'Run with the selected cloud runtime' },
    })
    const profileSelect = await screen.findByTestId(/^execution-node-runtime-profile-step-/)
    fireEvent.change(profileSelect, { target: { value: 'profile-cloud' } })
    expect(screen.getByTestId(/^execution-node-model-step-/)).toHaveValue('gpt-web')

    const pluginButton = screen.getByTestId(/^execution-node-add-plugin-step-/)
    fireEvent.click(pluginButton)
    await waitFor(() => expect(loadPlugins).toHaveBeenCalledWith(project.id, ['device-cloud']))
    fireEvent.click(
      await screen.findByTestId(/^execution-node-add-plugin-step-.*-option-plugin-github$/)
    )

    await waitFor(() => expect(createAutomation).toHaveBeenCalled(), { timeout: 3000 })
    const savedInput = createAutomation.mock.calls.at(-1)?.[1]
    const firstNode = savedInput.eventConfig.wework_flow.graph.nodes[0]
    expect(firstNode).toMatchObject({
      runtimeProfileId: 'profile-cloud',
      executionDeviceId: 'device-cloud',
      executionEnvironment: 'cloud',
      model: 'gpt-web',
      modelType: 'public',
      modelOptions: { reasoning_effort: 'medium' },
      plugins: expect.arrayContaining(['GitHub']),
      projectPlugins: [
        {
          id: 'plugin-github',
          pluginName: 'github',
          marketplaceId: 'official',
          displayName: 'GitHub',
        },
      ],
    })
    const workflowExecutionNode = savedInput.eventConfig.runtime_workflow_definition.nodes.find(
      (node: { id: string }) => node.id === firstNode.id
    )
    expect(workflowExecutionNode.execution_config).toMatchObject({
      runtime_profile_id: 'profile-cloud',
      execution_device_id: 'device-cloud',
      model: 'gpt-web',
      model_type: 'public',
      model_options: { reasoning_effort: 'medium' },
      project_plugins: [
        {
          id: 'plugin-github',
          pluginName: 'github',
          marketplaceId: 'official',
          displayName: 'GitHub',
        },
      ],
    })
    expect(savedInput).toMatchObject({
      runtimeSource: 'fixed_profile',
      runtimeProfileId: 'profile-cloud',
      model: 'gpt-web',
      executionEnvironment: 'cloud',
      executionDeviceId: 'device-cloud',
    })
  })
})
