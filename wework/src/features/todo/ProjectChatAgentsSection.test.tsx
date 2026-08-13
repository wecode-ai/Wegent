import '@/i18n'

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CloudProject } from '@/api/deliveries'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeWorkListResponse } from '@/types/api'
import { ProjectChatAgentsSection } from './ProjectChatAgentsSection'

const project = {
  id: '11',
  name: 'Wework',
  project_store: 'backend',
} as unknown as CloudProject

const MODEL_NAME = 'gpt-5-codex'

function agent(overrides: Partial<ProjectChatAgent> = {}): ProjectChatAgent {
  return {
    id: 'agent-1',
    projectId: project.id,
    name: 'Bug 修复机器人',
    runtime: 'codex',
    model: null,
    systemPrompt: '',
    status: 'active',
    visibility: 'creator_admin',
    executionEnvironment: 'local',
    executionMode: 'auto',
    executionDeviceId: 'local-device',
    localProjectId: null,
    createdByUserId: 1,
    createdByUserName: 'local',
    version: 1,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

function services(initialAgents: ProjectChatAgent[] = []) {
  const list = vi.fn(async () => initialAgents)
  const create = vi.fn(async (_projectId: string, input: unknown) => {
    const values = input as Partial<ProjectChatAgent>
    return agent({
      id: 'agent-created',
      name: values.name ?? '新机器人',
      model: values.model ?? null,
    })
  })
  const update = vi.fn(async (_projectId: string, _agentId: string, input: unknown) => {
    const values = input as Partial<ProjectChatAgent>
    return agent({ id: 'agent-1', model: values.model ?? null })
  })
  const projectChatAgentApi = {
    list,
    create,
    update,
  } as unknown as WorkbenchServices['projectChatAgentApi']
  const modelApi = {
    listModels: vi.fn(async () => ({
      data: [{ name: MODEL_NAME, type: 'runtime', displayName: 'GPT-5 Codex' }],
    })),
  }
  const deviceApi = {
    listDevices: vi.fn(async () => [
      { device_id: 'local-device', device_type: 'local', status: 'online' },
    ]),
  }
  return { projectChatAgentApi, modelApi, deviceApi, list, create, update }
}

function renderSection(mock: ReturnType<typeof services>) {
  render(
    <ProjectChatAgentsSection
      project={project}
      projectChatAgentApi={mock.projectChatAgentApi}
      deviceApi={mock.deviceApi}
      modelApi={mock.modelApi}
      localProjects={[]}
      canManage
    />
  )
}

describe('ProjectChatAgentsSection', () => {
  it('requires a model before a new robot can be saved', async () => {
    const mock = services()
    renderSection(mock)

    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-add'))
    await userEvent.type(screen.getByTestId('cloud-project-chat-agent-name'), '新机器人')
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-device'))
    await userEvent.click(
      await screen.findByTestId('cloud-project-chat-agent-device-option-local-device')
    )

    const save = screen.getByTestId('cloud-project-chat-agent-save')
    expect(save).toBeDisabled()

    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-model'))
    await userEvent.click(
      await screen.findByTestId(`cloud-project-chat-agent-model-option-${MODEL_NAME}`)
    )
    expect(save).toBeEnabled()

    await userEvent.click(save)
    await waitFor(() =>
      expect(mock.create).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({ model: MODEL_NAME })
      )
    )
    expect(await screen.findByTestId('cloud-project-chat-agent-agent-created')).toHaveTextContent(
      MODEL_NAME
    )
  })

  it('forces a model choice when editing a robot without one', async () => {
    const mock = services([agent()])
    renderSection(mock)

    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-agent-1'))
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-device'))
    await userEvent.click(
      await screen.findByTestId('cloud-project-chat-agent-device-option-local-device')
    )

    const save = screen.getByTestId('cloud-project-chat-agent-save')
    expect(save).toBeDisabled()

    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-model'))
    await userEvent.click(
      await screen.findByTestId(`cloud-project-chat-agent-model-option-${MODEL_NAME}`)
    )
    expect(save).toBeEnabled()

    await userEvent.click(save)
    await waitFor(() =>
      expect(mock.update).toHaveBeenCalledWith(
        project.id,
        'agent-1',
        expect.objectContaining({ model: MODEL_NAME })
      )
    )
  })

  it('hides local runtime models when the robot runs in the cloud', async () => {
    const mock = services()
    mock.modelApi = {
      listModels: vi.fn(async () => ({
        data: [
          { name: 'gpt-5-codex', type: 'runtime', displayName: 'GPT-5 Codex' },
          { name: 'kimi-k2', type: 'public', displayName: 'Kimi K2' },
        ],
      })),
    }
    renderSection(mock)

    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-add'))
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-model'))
    await userEvent.click(
      await screen.findByTestId('cloud-project-chat-agent-model-option-gpt-5-codex')
    )

    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-environment'))
    await userEvent.click(
      await screen.findByTestId('cloud-project-chat-agent-environment-option-cloud')
    )

    expect(screen.getByTestId('cloud-project-chat-agent-model')).toHaveTextContent('请选择模型')

    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-model'))
    expect(
      await screen.findByTestId('cloud-project-chat-agent-model-option-kimi-k2')
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('cloud-project-chat-agent-model-option-gpt-5-codex')
    ).not.toBeInTheDocument()
  })

  it('lists only projects with a workspace on the selected cloud device', async () => {
    const mock = services()
    mock.deviceApi = {
      listDevices: vi.fn(async () => [
        { device_id: 'local-device', device_type: 'local', status: 'online' },
        { device_id: 'cloud-device', device_type: 'cloud', status: 'online' },
      ]),
    }
    const runtimeWork = {
      projects: [
        {
          project: {
            key: 'p-101',
            id: 101,
            name: '云端项目',
            kind: 'remote',
            source: 'remote_project',
          },
          deviceWorkspaces: [
            { deviceId: 'cloud-device', available: true, workspacePath: '/srv/cloud-app' },
          ],
          tasks: [],
        },
        {
          project: { key: 'p-102', id: 102, name: '本机项目' },
          deviceWorkspaces: [
            { deviceId: 'local-device', available: true, workspacePath: '/home/local-app' },
          ],
          tasks: [],
        },
      ],
      chats: [],
      totalTasks: 0,
    } as unknown as RuntimeWorkListResponse
    render(
      <ProjectChatAgentsSection
        project={project}
        projectChatAgentApi={mock.projectChatAgentApi}
        deviceApi={mock.deviceApi}
        modelApi={mock.modelApi}
        localProjects={[{ id: 7, name: '桌面项目', tasks: [] } as never]}
        runtimeWork={runtimeWork}
        canManage
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-add'))
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-environment'))
    await userEvent.click(
      await screen.findByTestId('cloud-project-chat-agent-environment-option-cloud')
    )
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-device'))
    await userEvent.click(
      await screen.findByTestId('cloud-project-chat-agent-device-option-cloud-device')
    )
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-execution-project'))

    expect(
      await screen.findByTestId('cloud-project-chat-agent-execution-project-option-101')
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('cloud-project-chat-agent-execution-project-option-102')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('cloud-project-chat-agent-execution-project-option-7')
    ).not.toBeInTheDocument()
  })
})
