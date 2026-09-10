import { render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { runtimeProjectUiId } from '@/lib/runtime-project'
import type { RuntimeTaskAddress, RuntimeTaskCreateRequest } from '@/types/api'
import { BackgroundTaskStarter } from './BackgroundTaskStarter'

const mocks = vi.hoisted(() => ({
  createConversation: vi.fn(),
  useComposer: vi.fn(),
  runtimeWork: {
    projects: [],
    chats: [],
    totalTasks: 0,
  } as import('@/types/api').RuntimeWorkListResponse,
}))

vi.mock('./useProjectRuntimeTaskComposer', () => ({
  useProjectRuntimeTaskComposer: (options: unknown) => {
    mocks.useComposer(options)
    return mocks.createConversation
  },
}))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbenchPaneContext: () => ({
    state: {
      runtimeWork: mocks.runtimeWork,
    },
  }),
}))

describe('BackgroundTaskStarter', () => {
  it('starts the runtime task without rendering a UI surface', async () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'local-device',
      taskId: 'runtime-created',
    }
    const onAddressChange = vi.fn()
    mocks.createConversation.mockImplementation(async (_input, options) => {
      options.onRuntimeTaskOptimisticOpen(address)
      return address
    })

    const { container } = render(
      <BackgroundTaskStarter
        project={{
          id: 11,
          name: 'Wegent V4',
          description: '',
        }}
        localProjects={[{ id: 91, name: '运营工作区', tasks: [] }]}
        task={{
          id: 'WEG-1',
          cloud_project_id: 11,
          sequence_number: 1,
          parent_id: null,
          created_by_user_id: 1,
          assignee_user_id: null,
          title: 'Implement cloud MCP',
          description: 'Use the shared workspace',
          status: 'pending',
          priority: 'high',
          due_at: null,
          sort_order: 0,
          current_delivery_id: null,
          version: 1,
          created_at: '2026-07-22T00:00:00Z',
          updated_at: '2026-07-22T00:00:00Z',
          completed_at: null,
        }}
        input="Implement cloud MCP"
        initialLocalProjectId={91}
        onAddressChange={onAddressChange}
        onError={vi.fn()}
      />
    )

    expect(container).toBeEmptyDOMElement()
    await waitFor(() => expect(mocks.createConversation).toHaveBeenCalledOnce())
    expect(mocks.createConversation).toHaveBeenCalledWith(
      'Implement cloud MCP',
      expect.objectContaining({
        attachments: [],
        executionModel: {},
        optimisticUserMessage: expect.objectContaining({
          role: 'user',
          content: 'Implement cloud MCP',
        }),
      })
    )
    expect(onAddressChange).toHaveBeenCalledOnce()
    expect(onAddressChange).toHaveBeenCalledWith(address)
  })

  it('uses the project captured by the task request instead of the previous project', async () => {
    const taskRequest: RuntimeTaskCreateRequest = {
      schemaVersion: 2,
      runtime: 'codex',
      message: 'Implement cloud MCP',
      deviceId: 'local-device',
      runtimeProjectKey: 'primary-project',
      runtimeProjectName: '主项目',
      runtimeWorkspaceRoots: ['/workspace/primary'],
    }
    mocks.runtimeWork = {
      projects: [
        {
          project: {
            key: 'secondary-project',
            name: '次项目',
            source: 'local_project',
            stateDeviceId: 'local-device',
          },
          deviceWorkspaces: [
            {
              id: 901,
              deviceId: 'local-device',
              workspacePath: '/workspace/secondary',
              workspaceKind: 'worktree',
              workspaceSource: 'local',
              available: true,
              tasks: [],
            },
          ],
        },
        {
          project: {
            key: 'primary-project',
            name: '主项目',
            source: 'local_project',
            stateDeviceId: 'local-device',
          },
          deviceWorkspaces: [
            {
              id: 902,
              deviceId: 'local-device',
              workspacePath: '/workspace/primary',
              workspaceKind: 'worktree',
              workspaceSource: 'local',
              available: true,
              tasks: [],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 0,
    }
    const runtimeProjectId = runtimeProjectUiId(mocks.runtimeWork.projects[1].project)
    mocks.createConversation.mockResolvedValue(false)

    render(
      <BackgroundTaskStarter
        project={{
          id: 11,
          name: 'Wegent V4',
          description: '',
        }}
        localProjects={[
          { id: 91, name: '次项目', tasks: [] },
          { id: runtimeProjectId, name: '主项目', tasks: [] },
        ]}
        task={{
          id: 'WEG-1',
          cloud_project_id: 11,
          sequence_number: 1,
          parent_id: null,
          created_by_user_id: 1,
          assignee_user_id: null,
          title: 'Implement cloud MCP',
          description: 'Use the shared workspace',
          status: 'pending',
          priority: 'high',
          due_at: null,
          sort_order: 0,
          current_delivery_id: null,
          version: 1,
          created_at: '2026-07-22T00:00:00Z',
          updated_at: '2026-07-22T00:00:00Z',
          completed_at: null,
        }}
        input="Implement cloud MCP"
        initialLocalProjectId={91}
        taskRequest={taskRequest}
        onAddressChange={vi.fn()}
        onError={vi.fn()}
      />
    )

    await waitFor(() =>
      expect(mocks.useComposer).toHaveBeenLastCalledWith(
        expect.objectContaining({
          project: expect.objectContaining({ id: runtimeProjectId, name: '主项目' }),
          taskRequest,
        })
      )
    )
  })

  it('passes a force-start create intent to the runtime composer', async () => {
    const taskRequest: RuntimeTaskCreateRequest = {
      runtime: 'codex',
      message: 'Implement cloud MCP',
      forceStart: true,
    }
    mocks.createConversation.mockResolvedValue({
      deviceId: 'local-device',
      taskId: 'runtime-created',
    })

    render(
      <BackgroundTaskStarter
        project={{
          id: 11,
          name: 'Wegent V4',
          description: '',
        }}
        localProjects={[]}
        task={{
          id: 'WEG-1',
          cloud_project_id: 11,
          sequence_number: 1,
          parent_id: null,
          created_by_user_id: 1,
          assignee_user_id: null,
          title: 'Implement cloud MCP',
          description: '',
          status: 'in_progress',
          priority: 'high',
          due_at: null,
          sort_order: 0,
          current_delivery_id: null,
          version: 1,
          created_at: '2026-07-22T00:00:00Z',
          updated_at: '2026-07-22T00:00:00Z',
          completed_at: null,
        }}
        input="Implement cloud MCP"
        taskRequest={taskRequest}
        onAddressChange={vi.fn()}
        onError={vi.fn()}
      />
    )

    await waitFor(() =>
      expect(mocks.useComposer).toHaveBeenLastCalledWith(
        expect.objectContaining({
          taskRequest,
        })
      )
    )
  })
})
