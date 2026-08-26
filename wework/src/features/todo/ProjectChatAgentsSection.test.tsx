import '@/i18n'

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CloudProject } from '@/api/deliveries'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type { RuntimeProfile } from '@/api/runtimeProfiles'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeWorkListResponse } from '@/types/api'
import { ProjectChatAgentsSection } from './ProjectChatAgentsSection'

const project = {
  id: '11',
  name: 'Wework',
  project_store: 'backend',
} as unknown as CloudProject

const MODEL_NAME = 'gpt-5-codex'
const RUNTIME_MODEL_OPTION_TEST_ID = `cloud-project-chat-agent-model-option-runtime:${MODEL_NAME}`

function runtimeProfile(overrides: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return {
    id: 'runtime-local',
    name: '我的本地',
    executionEnvironment: 'local',
    executionDeviceId: 'local-device',
    model: MODEL_NAME,
    modelType: 'runtime',
    modelOptions: {},
    workspacePolicy: 'project',
    status: 'active',
    version: 1,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

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
    workspaceBinding: { type: 'standalone', status: 'ready' },
    localProjectId: null,
    maxConcurrentExecutions: 1,
    workspacePolicy: 'project',
    defaultRuntimeProfileId: null,
    plugins: [],
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
      defaultRuntimeProfileId: values.defaultRuntimeProfileId ?? null,
    })
  })
  const update = vi.fn(async (_projectId: string, _agentId: string, input: unknown) => {
    const values = input as Partial<ProjectChatAgent>
    return agent({
      id: 'agent-1',
      model: values.model ?? null,
      defaultRuntimeProfileId: values.defaultRuntimeProfileId ?? null,
    })
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
      {
        device_id: 'local-device',
        device_type: 'local',
        status: 'online',
        executor_version: '1.8.5',
      },
    ]),
    executeCommand: vi.fn(async () => ({ success: true, stdout: 'true' })),
  }
  const teamApi = {
    listTeams: vi.fn(async () => [
      {
        id: 42,
        name: 'development-team',
        displayName: 'Development Team',
        is_active: true,
      },
    ]),
  }
  const pluginApi = {
    listPlugins: vi.fn(async () => [
      {
        id: 'github@openai',
        pluginName: 'github',
        marketplaceId: 'openai',
        displayName: 'GitHub',
      },
    ]),
  } as unknown as WorkbenchServices['pluginApi']
  return {
    projectChatAgentApi,
    modelApi,
    deviceApi,
    teamApi,
    pluginApi,
    list,
    create,
    update,
  }
}

function renderSection(mock: ReturnType<typeof services>, runtimeProfiles: RuntimeProfile[] = []) {
  return render(
    <ProjectChatAgentsSection
      project={project}
      projectChatAgentApi={mock.projectChatAgentApi}
      deviceApi={mock.deviceApi}
      modelApi={mock.modelApi}
      teamApi={mock.teamApi}
      pluginApi={mock.pluginApi}
      localProjects={[]}
      runtimeProfiles={runtimeProfiles}
      canManage
    />
  )
}

describe('ProjectChatAgentsSection', () => {
  it('opens the robot editor when the workflow requests a new robot', async () => {
    const mock = services()
    const view = renderSection(mock)

    await screen.findByTestId('cloud-project-chat-agent-add')
    view.rerender(
      <ProjectChatAgentsSection
        project={project}
        projectChatAgentApi={mock.projectChatAgentApi}
        deviceApi={mock.deviceApi}
        modelApi={mock.modelApi}
        teamApi={mock.teamApi}
        localProjects={[]}
        runtimeProfiles={[]}
        canManage
        createRequestKey={1}
      />
    )

    expect(await screen.findByTestId('cloud-project-chat-agent-editor')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-chat-agent-runtime-group')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-chat-agent-capability')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-chat-agent-system-prompt')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-chat-agent-mode')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-chat-agent-access-group')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-device'))
    expect(
      await screen.findByTestId('cloud-project-chat-agent-device-option-local-device')
    ).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-advanced-toggle'))

    expect(screen.getByTestId('cloud-project-chat-agent-capability')).toHaveValue('')
    expect(screen.getByTestId('cloud-project-chat-agent-system-prompt')).toHaveValue('')
  })

  it('binds a Wegent Agent inside the board robot runtime configuration', async () => {
    const mock = services()
    renderSection(mock)

    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-add'))
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-environment'))
    await userEvent.click(
      await screen.findByTestId('cloud-project-chat-agent-environment-option-wegent')
    )

    expect(screen.queryByTestId('cloud-project-chat-agent-device')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-chat-agent-model')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-wegent-team'))
    await userEvent.click(
      await screen.findByTestId('cloud-project-chat-agent-wegent-team-option-42')
    )
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-save'))

    await waitFor(() =>
      expect(mock.create).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({
          runtime: 'wegent',
          wegentTeamId: 42,
          executionDeviceId: null,
          workspaceBinding: { type: 'standalone' },
        })
      )
    )
  })

  it('offers three templates with breathing room when no robots have been added', async () => {
    const mock = services()
    renderSection(mock)

    const templates = await screen.findByTestId('project-chat-agent-template-planning')
    expect(templates.parentElement?.parentElement).toHaveClass('mt-5')
    expect(screen.getByTestId('project-chat-agent-template-development')).toBeInTheDocument()
    expect(screen.getByTestId('project-chat-agent-template-review')).toBeInTheDocument()
  })

  it('opens the robot editor with all selected template defaults', async () => {
    const mock = services()
    renderSection(mock)

    await userEvent.click(await screen.findByTestId('project-chat-agent-template-development'))

    expect(screen.getByTestId('cloud-project-chat-agent-name')).toHaveValue('开发实现机器人')
    expect(screen.getByTestId('cloud-project-chat-agent-capability')).toHaveValue(
      '编写代码、修复问题并完成必要验证'
    )
    expect(screen.getByTestId('cloud-project-chat-agent-system-prompt')).toHaveValue(
      '你负责完成被指派的开发任务。先阅读项目约定和相关代码，确认问题根因与影响范围，再复用现有抽象实现最小而完整的修改。同步补充必要测试，运行与改动风险相称的验证，并清楚汇报结果、剩余风险和任何需要人工确认的事项。'
    )
  })

  it('opens the robot editor across the webview with a split layout', async () => {
    const mock = services()
    renderSection(mock)

    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-add'))
    const editor = screen.getByTestId('cloud-project-chat-agent-editor')
    expect(editor.closest('section')?.parentElement?.parentElement).toBe(document.body)
    expect(editor).toHaveClass('grid', 'md:grid-cols-[minmax(0,1.65fr)_minmax(360px,1fr)]')
  })

  it('shows either custom runtime environment controls or a reusable template', async () => {
    const mock = services()
    renderSection(mock, [runtimeProfile()])

    await userEvent.click(await screen.findByTestId('project-chat-agent-template-planning'))

    const runtimeGroup = screen.getByTestId('cloud-project-chat-agent-runtime-group')
    expect(within(runtimeGroup).getByText('运行环境')).toBeInTheDocument()
    expect(within(runtimeGroup).getByText('运行方式')).toBeInTheDocument()
    expect(within(runtimeGroup).getByText('配置方式')).toBeInTheDocument()
    expect(runtimeGroup).not.toHaveTextContent('workbench.project_chat_agent_')
    expect(screen.getByTestId('cloud-project-chat-agent-device')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-chat-agent-model')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-chat-agent-execution-project')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-chat-agent-runtime-profile')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-runtime-configuration-mode'))
    await userEvent.click(
      await screen.findByTestId(
        'cloud-project-chat-agent-runtime-configuration-mode-option-template'
      )
    )

    expect(screen.getByTestId('cloud-project-chat-agent-runtime-profile')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-chat-agent-device')).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('cloud-project-chat-agent-execution-project')
    ).not.toBeInTheDocument()
  })

  it('creates a robot without binding a reusable Runtime profile', async () => {
    const mock = services()
    renderSection(mock)

    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-add'))
    await userEvent.type(
      screen.getByTestId('cloud-project-chat-agent-capability'),
      '擅长前端交互与可访问性实现'
    )
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-model'))
    await userEvent.click(await screen.findByTestId(RUNTIME_MODEL_OPTION_TEST_ID))
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-save'))
    await waitFor(() =>
      expect(mock.create).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({
          capabilityDescription: '擅长前端交互与可访问性实现',
          defaultRuntimeProfileId: null,
        })
      )
    )
  })

  it('persists plugins selected from the Wework installation list', async () => {
    const mock = services()
    renderSection(mock)

    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-add'))
    await userEvent.click(
      await screen.findByTestId('cloud-project-chat-agent-plugin-github@openai')
    )
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-model'))
    await userEvent.click(await screen.findByTestId(RUNTIME_MODEL_OPTION_TEST_ID))
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-save'))

    await waitFor(() => expect(mock.pluginApi?.listPlugins).toHaveBeenCalledWith('local-device'))
    await waitFor(() =>
      expect(mock.create).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({
          plugins: [
            {
              id: 'github@openai',
              pluginName: 'github',
              marketplaceId: 'openai',
              displayName: 'GitHub',
            },
          ],
        })
      )
    )
  })

  it('returns the newly created robot to the requesting workflow', async () => {
    const mock = services()
    const onAgentCreated = vi.fn()
    render(
      <ProjectChatAgentsSection
        project={project}
        projectChatAgentApi={mock.projectChatAgentApi}
        deviceApi={mock.deviceApi}
        modelApi={mock.modelApi}
        teamApi={mock.teamApi}
        localProjects={[]}
        runtimeProfiles={[]}
        canManage
        createRequestKey={1}
        onAgentCreated={onAgentCreated}
      />
    )

    await screen.findByTestId('cloud-project-chat-agent-editor')
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-model'))
    await userEvent.click(await screen.findByTestId(RUNTIME_MODEL_OPTION_TEST_ID))
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-save'))

    await waitFor(() =>
      expect(onAgentCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'agent-created',
          name: '新机器人',
        })
      )
    )
  })

  it('binds the exact selected device id when multiple local apps are online', async () => {
    const mock = services()
    mock.deviceApi.listDevices = vi.fn(async () => [
      {
        device_id: 'device-app-one',
        name: 'Wework App 1',
        device_type: 'local',
        status: 'online',
        is_default: true,
      },
      {
        device_id: 'device-app-two',
        name: 'Wework App 2',
        device_type: 'local',
        status: 'online',
      },
      {
        device_id: 'device-app-three',
        name: 'Wework App 3',
        device_type: 'local',
        status: 'online',
      },
    ])
    render(
      <ProjectChatAgentsSection
        project={project}
        projectChatAgentApi={mock.projectChatAgentApi}
        deviceApi={mock.deviceApi}
        modelApi={mock.modelApi}
        teamApi={mock.teamApi}
        localProjects={[]}
        runtimeProfiles={[]}
        canManage
        createRequestKey={1}
      />
    )

    await screen.findByTestId('cloud-project-chat-agent-editor')
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-device'))
    expect(await screen.findByText('Wework App 2 · device-app-two')).toBeInTheDocument()
    await userEvent.click(
      screen.getByTestId('cloud-project-chat-agent-device-option-device-app-two')
    )
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-model'))
    await userEvent.click(await screen.findByTestId(RUNTIME_MODEL_OPTION_TEST_ID))
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-save'))

    await waitFor(() =>
      expect(mock.create).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({
          executionDeviceId: 'device-app-two',
        })
      )
    )
  })

  it('creates a robot from an online runtime environment template', async () => {
    const mock = services()
    mock.deviceApi.listDevices = vi.fn(async () => [
      { device_id: 'local-device', device_type: 'local', status: 'online' },
      { device_id: 'offline-device', device_type: 'cloud', status: 'offline' },
    ])
    renderSection(mock, [
      runtimeProfile(),
      runtimeProfile({
        id: 'runtime-offline',
        name: '离线云端',
        executionEnvironment: 'cloud',
        executionDeviceId: 'offline-device',
        model: 'kimi-k2',
        modelType: 'public',
      }),
    ])

    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-add'))
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-runtime-configuration-mode'))
    await userEvent.click(
      await screen.findByTestId(
        'cloud-project-chat-agent-runtime-configuration-mode-option-template'
      )
    )

    expect(screen.getByTestId('cloud-project-chat-agent-runtime-profile')).toHaveTextContent(
      '我的本地'
    )
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-runtime-profile'))
    expect(
      await screen.findByTestId('cloud-project-chat-agent-runtime-profile-option-runtime-local')
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('cloud-project-chat-agent-runtime-profile-option-runtime-offline')
    ).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-save'))

    await waitFor(() =>
      expect(mock.create).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({
          defaultRuntimeProfileId: 'runtime-local',
          executionEnvironment: 'local',
          executionDeviceId: 'local-device',
          model: MODEL_NAME,
          workspaceBinding: { type: 'standalone' },
        })
      )
    )
  })

  it('clears a previous save error when the corrected robot saves successfully', async () => {
    const mock = services([agent({ model: MODEL_NAME })])
    mock.update.mockRejectedValueOnce(new Error('旧的保存错误'))
    renderSection(mock)

    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-agent-1'))
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-save'))
    expect(await screen.findByTestId('cloud-project-chat-agent-error')).toHaveTextContent(
      '旧的保存错误'
    )

    await userEvent.type(screen.getByTestId('cloud-project-chat-agent-capability'), '已修正配置')
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-save'))

    await waitFor(() => expect(mock.update).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId('cloud-project-chat-agent-editor')).not.toBeInTheDocument()
    expect(screen.queryByText('旧的保存错误')).not.toBeInTheDocument()
  })
  it('selects a local device when editing a local-project robot with a stale cloud device', async () => {
    const mock = services([
      agent({
        model: MODEL_NAME,
        executionEnvironment: 'cloud',
        executionDeviceId: 'stale-cloud-device',
      }),
    ])
    mock.deviceApi.listDevices = vi.fn(async () => [
      { device_id: 'local-device', device_type: 'local', status: 'online' },
      { device_id: 'stale-cloud-device', device_type: 'cloud', status: 'online' },
    ])
    render(
      <ProjectChatAgentsSection
        project={{ ...project, project_store: 'local' }}
        projectChatAgentApi={mock.projectChatAgentApi}
        deviceApi={mock.deviceApi}
        modelApi={mock.modelApi}
        teamApi={mock.teamApi}
        localProjects={[]}
        canManage
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-agent-1'))

    expect(screen.getByTestId('cloud-project-chat-agent-environment')).toHaveTextContent('Wework')
    expect(screen.getByTestId('cloud-project-chat-agent-device')).toHaveTextContent('local-device')
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
    mock.deviceApi.listDevices = vi.fn(async () => [
      { device_id: 'local-device', device_type: 'local', status: 'online' },
      { device_id: 'cloud-device', device_type: 'cloud', status: 'online' },
    ])
    renderSection(mock)

    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-add'))
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-model'))
    await userEvent.click(await screen.findByTestId(RUNTIME_MODEL_OPTION_TEST_ID))

    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-device'))
    await userEvent.click(
      await screen.findByTestId('cloud-project-chat-agent-device-option-cloud-device')
    )

    await waitFor(() => expect(mock.pluginApi?.listPlugins).toHaveBeenCalledWith('cloud-device'))
    expect(screen.getByTestId('cloud-project-chat-agent-model')).toHaveTextContent('请选择模型')

    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-model'))
    expect(
      await screen.findByTestId('cloud-project-chat-agent-model-option-public:kimi-k2')
    ).toBeInTheDocument()
    expect(screen.queryByTestId(RUNTIME_MODEL_OPTION_TEST_ID)).not.toBeInTheDocument()
  })

  it('lists only projects with a workspace on the selected cloud device', async () => {
    const mock = services()
    mock.deviceApi.listDevices = vi.fn(async () => [
      { device_id: 'local-device', device_type: 'local', status: 'online' },
      { device_id: 'cloud-device', device_type: 'cloud', status: 'online' },
    ])
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
            {
              id: 501,
              projectId: 101,
              deviceId: 'cloud-device',
              available: true,
              workspacePath: '/srv/cloud-app',
            },
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
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-device'))
    await userEvent.click(
      await screen.findByTestId('cloud-project-chat-agent-device-option-cloud-device')
    )
    await waitFor(() =>
      expect(screen.getByTestId('cloud-project-chat-agent-device')).toHaveTextContent(
        'cloud-device'
      )
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

    await userEvent.click(
      screen.getByTestId('cloud-project-chat-agent-execution-project-option-101')
    )
    expect(screen.getByTestId('cloud-project-chat-agent-execution-project')).toHaveTextContent(
      '云端项目'
    )
    expect(
      screen.queryByTestId('cloud-project-chat-agent-device-workspace')
    ).not.toBeInTheDocument()
  })

  it('auto-selects the preferred device when an environment has multiple devices', async () => {
    const mock = services()
    mock.deviceApi.listDevices = vi.fn(async () => [
      {
        device_id: 'offline-default-device',
        device_type: 'local',
        status: 'offline',
        is_default: true,
      },
      { device_id: 'online-device', device_type: 'app', status: 'online' },
      {
        device_id: 'online-default-device',
        device_type: 'local',
        status: 'online',
        is_default: true,
      },
    ])
    renderSection(mock)

    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-add'))

    await waitFor(() => {
      expect(screen.getByTestId('cloud-project-chat-agent-device')).toHaveTextContent(
        'online-default-device'
      )
      expect(
        screen.getByTestId('cloud-project-chat-agent-device').firstElementChild
      ).toHaveAttribute('data-selection-state', 'selected')
    })
  })

  it('auto-selects a sole device when devices load after the editor opens', async () => {
    const mock = services()
    let resolveDevices:
      | ((devices: Array<{ device_id: string; device_type: string; status: string }>) => void)
      | undefined
    mock.deviceApi.listDevices = vi.fn(
      () =>
        new Promise(resolve => {
          resolveDevices = resolve
        })
    )
    renderSection(mock)

    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-add'))
    expect(screen.getByTestId('cloud-project-chat-agent-device')).toHaveTextContent('选择设备')

    await act(async () => {
      resolveDevices?.([{ device_id: 'late-local-device', device_type: 'local', status: 'online' }])
    })

    expect(screen.getByTestId('cloud-project-chat-agent-device')).toHaveTextContent(
      'late-local-device'
    )
  })

  it('offers a per-task worktree policy for a bound Git workspace', async () => {
    const mock = services([
      agent({
        model: MODEL_NAME,
        workspaceBinding: {
          type: 'backend_project',
          status: 'ready',
          projectId: 7,
          deviceId: 'local-device',
        },
        localProjectId: 7,
        maxConcurrentExecutions: 1,
      }),
    ])
    const runtimeWork = {
      projects: [
        {
          project: { key: 'p-7', id: 7, name: '桌面项目' },
          deviceWorkspaces: [
            { deviceId: 'local-device', available: true, workspacePath: '/repo/project' },
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

    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-agent-1'))
    await waitFor(() =>
      expect(mock.deviceApi.executeCommand).toHaveBeenCalledWith('local-device', {
        command_key: 'git_is_worktree',
        args: ['/repo/project'],
        timeout_seconds: 15,
        max_output_bytes: 4096,
      })
    )
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-workspace-policy'))
    await userEvent.click(
      await screen.findByTestId('cloud-project-chat-agent-workspace-policy-option-git_worktree')
    )
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-save'))

    expect(mock.update).toHaveBeenCalledWith(
      project.id,
      'agent-1',
      expect.objectContaining({ workspacePolicy: 'git_worktree' })
    )
  })

  it('creates a code project from the binding menu and selects it by default', async () => {
    const mock = services()
    const onCreateLocalCodeProject = vi.fn(async () => ({
      id: 91,
      name: 'New project',
      runtimeProjectKey: 'runtime-project-91',
      tasks: [],
    }))
    render(
      <ProjectChatAgentsSection
        project={project}
        projectChatAgentApi={mock.projectChatAgentApi}
        deviceApi={mock.deviceApi}
        modelApi={mock.modelApi}
        localProjects={[]}
        onCreateLocalCodeProject={onCreateLocalCodeProject}
        onGetDeviceHomeDirectory={vi.fn(async () => '/home/local')}
        onListDeviceDirectories={vi.fn(async () => [])}
        onCreateDeviceDirectory={vi.fn(async () => undefined)}
        canManage
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-add'))
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-execution-project'))
    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-create-code-project'))

    expect(screen.getByTestId('standalone-folder-project-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('standalone-folder-project-dialog-overlay')).toHaveClass(
      'z-system-popover'
    )
    expect(screen.queryByTestId('standalone-remote-device-select')).not.toBeInTheDocument()
    expect(screen.getByTestId('remote-project-source-existing')).toBeInTheDocument()
    expect(screen.getByTestId('remote-project-source-blank')).toBeInTheDocument()
    expect(screen.getByTestId('remote-project-source-git')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('remote-project-source-blank'))
    await userEvent.type(await screen.findByTestId('device-folder-name-input'), 'New project')
    await userEvent.click(screen.getByTestId('confirm-device-folder-picker-button'))

    await waitFor(() =>
      expect(onCreateLocalCodeProject).toHaveBeenCalledWith({
        deviceId: 'local-device',
        name: 'New project',
        roots: ['/home/local/New project'],
      })
    )
    expect(screen.queryByTestId('standalone-folder-project-dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-project-chat-agent-execution-project')).toHaveTextContent(
      'New project'
    )

    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-model'))
    await userEvent.click(await screen.findByTestId(RUNTIME_MODEL_OPTION_TEST_ID))
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-save'))

    await waitFor(() =>
      expect(mock.create).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({
          workspaceBinding: {
            type: 'device_project',
            deviceId: 'local-device',
            runtimeProjectKey: 'runtime-project-91',
          },
        })
      )
    )
  })

  it('offers code project creation for the selected cloud device', async () => {
    const mock = services()
    mock.deviceApi.listDevices.mockResolvedValue([
      {
        device_id: 'cloud-device',
        device_type: 'cloud',
        status: 'online',
        executor_version: '1.8.5',
      },
    ] as never)
    render(
      <ProjectChatAgentsSection
        project={project}
        projectChatAgentApi={mock.projectChatAgentApi}
        deviceApi={mock.deviceApi}
        modelApi={mock.modelApi}
        localProjects={[]}
        onCreateLocalCodeProject={vi.fn()}
        onGetDeviceHomeDirectory={vi.fn(async () => '/home/cloud')}
        onListDeviceDirectories={vi.fn(async () => [])}
        onCreateDeviceDirectory={vi.fn(async () => undefined)}
        canManage
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-add'))
    expect(screen.getByTestId('cloud-project-chat-agent-device')).toHaveTextContent('cloud-device')
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-execution-project'))
    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-create-code-project'))

    expect(screen.getByTestId('standalone-folder-project-dialog')).toBeInTheDocument()
    expect(screen.queryByTestId('standalone-remote-device-select')).not.toBeInTheDocument()
    expect(screen.getByTestId('remote-project-source-existing')).toBeInTheDocument()
    expect(screen.getByTestId('remote-project-source-blank')).toBeInTheDocument()
    expect(screen.getByTestId('remote-project-source-git')).toBeInTheDocument()
  })

  it('allows concurrency above one while disabling per-task worktrees for non-Git projects', async () => {
    const mock = services([
      agent({
        model: MODEL_NAME,
        workspaceBinding: {
          type: 'backend_project',
          status: 'ready',
          projectId: 7,
          deviceId: 'local-device',
        },
        localProjectId: 7,
        maxConcurrentExecutions: 1,
      }),
    ])
    mock.deviceApi.executeCommand.mockResolvedValue({ success: true, stdout: '' } as never)
    const runtimeWork = {
      projects: [
        {
          project: { key: 'p-7', id: 7, name: '普通目录' },
          deviceWorkspaces: [
            { deviceId: 'local-device', available: true, workspacePath: '/plain/project' },
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
        localProjects={[{ id: 7, name: '普通目录', tasks: [] } as never]}
        runtimeWork={runtimeWork}
        canManage
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-agent-1'))
    await waitFor(() =>
      expect(mock.deviceApi.executeCommand).toHaveBeenCalledWith(
        'local-device',
        expect.objectContaining({ args: ['/plain/project'] })
      )
    )
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-workspace-policy'))
    expect(
      await screen.findByTestId('cloud-project-chat-agent-workspace-policy-option-git_worktree')
    ).toBeDisabled()
    const concurrency = screen.getByTestId('cloud-project-chat-agent-max-concurrent-executions')
    fireEvent.change(concurrency, { target: { value: '2' } })
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-save'))

    expect(mock.update).toHaveBeenCalledWith(
      project.id,
      'agent-1',
      expect.objectContaining({
        maxConcurrentExecutions: 2,
        workspacePolicy: 'project',
      })
    )
  })
})
