import '@/i18n'

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    maxConcurrentExecutions: 1,
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
  return { projectChatAgentApi, modelApi, deviceApi, teamApi, list, create, update }
}

function renderSection(mock: ReturnType<typeof services>) {
  render(
    <ProjectChatAgentsSection
      project={project}
      projectChatAgentApi={mock.projectChatAgentApi}
      deviceApi={mock.deviceApi}
      modelApi={mock.modelApi}
      teamApi={mock.teamApi}
      localProjects={[]}
      canManage
    />
  )
}

describe('ProjectChatAgentsSection', () => {
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
          localProjectId: null,
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

  it('groups robot options in dependency order', async () => {
    const mock = services()
    renderSection(mock)

    await userEvent.click(await screen.findByTestId('project-chat-agent-template-planning'))

    const runtimeGroup = screen.getByTestId('cloud-project-chat-agent-runtime-group')
    expect(within(runtimeGroup).getByText('运行环境')).toBeInTheDocument()
    expect(
      Array.from(runtimeGroup.querySelectorAll<HTMLElement>('[data-testid]')).map(
        element => element.dataset.testid
      )
    ).toEqual([
      'cloud-project-chat-agent-environment',
      'cloud-project-chat-agent-device',
      'cloud-project-chat-agent-execution-project',
    ])
    expect(within(runtimeGroup).getByText('决定可用设备和模型')).toBeInTheDocument()
    expect(within(runtimeGroup).getByText('使用所选设备的工作区')).toBeInTheDocument()

    const executionGroup = screen.getByTestId('cloud-project-chat-agent-execution-group')
    expect(within(executionGroup).getByText('执行策略')).toBeInTheDocument()
    expect(
      Array.from(executionGroup.querySelectorAll<HTMLElement>('[data-testid]')).map(
        element => element.dataset.testid
      )
    ).toEqual([
      'cloud-project-chat-agent-model',
      'cloud-project-chat-agent-mode',
      'cloud-project-chat-agent-max-concurrent-executions',
    ])

    const accessGroup = screen.getByTestId('cloud-project-chat-agent-access-group')
    expect(within(accessGroup).getByText('访问权限')).toBeInTheDocument()
    expect(
      within(accessGroup).getByTestId('cloud-project-chat-agent-visibility')
    ).toBeInTheDocument()
  })

  it('distinguishes selected and unselected states, then validates required selections', async () => {
    const mock = services()
    renderSection(mock)

    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-add'))

    const selectionState = (testId: string) => screen.getByTestId(testId).firstElementChild
    expect(selectionState('cloud-project-chat-agent-environment')).toHaveAttribute(
      'data-selection-state',
      'selected'
    )
    expect(selectionState('cloud-project-chat-agent-environment')).toHaveClass('text-text-primary')
    expect(selectionState('cloud-project-chat-agent-model')).toHaveAttribute(
      'data-selection-state',
      'unselected'
    )
    expect(selectionState('cloud-project-chat-agent-model')).toHaveClass('text-text-muted')
    expect(selectionState('cloud-project-chat-agent-device')).toHaveAttribute(
      'data-selection-state',
      'unselected'
    )
    expect(selectionState('cloud-project-chat-agent-execution-project')).toHaveAttribute(
      'data-selection-state',
      'unselected'
    )
    expect(selectionState('cloud-project-chat-agent-execution-project')).toHaveClass(
      'text-text-muted'
    )
    expect(screen.getAllByText('(必填)')).toHaveLength(2)

    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-save'))
    expect(selectionState('cloud-project-chat-agent-model')).toHaveAttribute('data-invalid', 'true')
    expect(selectionState('cloud-project-chat-agent-device')).toHaveAttribute(
      'data-invalid',
      'true'
    )
    expect(mock.create).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-model'))
    expect(screen.queryByTestId('cloud-project-chat-agent-model-option-')).not.toBeInTheDocument()
    await userEvent.click(
      await screen.findByTestId(`cloud-project-chat-agent-model-option-${MODEL_NAME}`)
    )
    expect(selectionState('cloud-project-chat-agent-model')).toHaveAttribute(
      'data-selection-state',
      'selected'
    )
    expect(selectionState('cloud-project-chat-agent-model')).not.toHaveAttribute('data-invalid')
  })

  it('requires a model before a new robot can be saved', async () => {
    const mock = services()
    renderSection(mock)

    await userEvent.click(await screen.findByTestId('cloud-project-chat-agent-add'))
    await userEvent.type(screen.getByTestId('cloud-project-chat-agent-name'), '新机器人')
    await userEvent.type(
      screen.getByTestId('cloud-project-chat-agent-capability'),
      '擅长前端交互与可访问性实现'
    )
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-device'))
    await userEvent.click(
      await screen.findByTestId('cloud-project-chat-agent-device-option-local-device')
    )

    const save = screen.getByTestId('cloud-project-chat-agent-save')
    expect(save).toBeEnabled()
    await userEvent.click(save)
    expect(screen.getByTestId('cloud-project-chat-agent-model')).toHaveAttribute(
      'aria-invalid',
      'true'
    )
    expect(mock.create).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-model'))
    await userEvent.click(
      await screen.findByTestId(`cloud-project-chat-agent-model-option-${MODEL_NAME}`)
    )
    expect(save).toBeEnabled()

    await userEvent.click(save)
    await waitFor(() =>
      expect(mock.create).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({
          model: MODEL_NAME,
          capabilityDescription: '擅长前端交互与可访问性实现',
        })
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
    expect(save).toBeEnabled()
    await userEvent.click(save)
    expect(screen.getByTestId('cloud-project-chat-agent-model')).toHaveAttribute(
      'aria-invalid',
      'true'
    )
    expect(mock.update).not.toHaveBeenCalled()

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

  it('verifies a bound Git workspace before enabling robot concurrency above one', async () => {
    const mock = services([
      agent({ model: MODEL_NAME, localProjectId: 7, maxConcurrentExecutions: 1 }),
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
    const concurrency = screen.getByTestId('cloud-project-chat-agent-max-concurrent-executions')
    fireEvent.change(concurrency, { target: { value: '2' } })
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-save'))

    await waitFor(() =>
      expect(mock.deviceApi.executeCommand).toHaveBeenCalledWith('local-device', {
        command_key: 'git_is_worktree',
        args: ['/repo/project'],
        timeout_seconds: 15,
        max_output_bytes: 4096,
      })
    )
    expect(mock.update).toHaveBeenCalledWith(
      project.id,
      'agent-1',
      expect.objectContaining({ maxConcurrentExecutions: 2 })
    )
  })

  it('rejects robot concurrency above one for a bound non-Git workspace', async () => {
    const mock = services([
      agent({ model: MODEL_NAME, localProjectId: 7, maxConcurrentExecutions: 1 }),
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
    const concurrency = screen.getByTestId('cloud-project-chat-agent-max-concurrent-executions')
    fireEvent.change(concurrency, { target: { value: '2' } })
    await userEvent.click(screen.getByTestId('cloud-project-chat-agent-save'))

    expect(await screen.findByTestId('cloud-project-chat-agent-error')).toHaveTextContent(
      '绑定代码项目只有在所选设备上是可用的 Git 工作区时'
    )
    expect(mock.update).not.toHaveBeenCalled()
  })
})
