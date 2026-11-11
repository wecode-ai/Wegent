import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { RunnerEnvironment, RunnerModelIdentity } from '@wegent/collaboration'

import type { createAgentResourceApi } from '@/api/agentResources'
import { DEFAULT_WORK_ITEM_PROJECT_ID } from '@/api/deliveries'
import {
  createWeworkProjectAgentConfigurationHost,
  weworkProjectAgentConfigurationHost,
} from './WeworkProjectAgentConfigurationHost'

const codexModel: RunnerModelIdentity = {
  runtime: 'codex',
  provider: 'openai',
  model_id: 'gpt-5',
  source: 'native',
}
const claudeModel: RunnerModelIdentity = {
  runtime: 'claude_code',
  provider: 'anthropic',
  model_id: 'claude-sonnet',
  source: 'native',
}
const modelValue = (model: RunnerModelIdentity) =>
  JSON.stringify([model.runtime, model.provider, model.model_id])
const runnerEnvironments: RunnerEnvironment[] = [
  {
    id: '1',
    device_key: 'local-device',
    name: 'Test runner',
    owner_type: 'user',
    owner_id: '1',
    status: 'online',
    project_authorized: true,
    models: [codexModel, claudeModel].map(model => ({
      ...model,
      label: model.model_id,
      local_model_id: model.model_id,
      account_label: 'Runner account',
      is_default: true,
    })),
  },
]
const runnerCatalog = () => vi.fn(async () => runnerEnvironments)

async function selectProjectNativeModel(prefix: string) {
  const dialog =
    prefix === 'wework-agent' ? 'wework-agent-resource-creator' : 'cloud-project-chat-agent-editor'
  expect(screen.getByTestId(`${prefix}-model`)).not.toBeVisible()
  fireEvent.click(screen.getByTestId(`${dialog}-runtime-summary`))
  expect(screen.getByTestId(`${prefix}-environment`)).toHaveAttribute(
    'data-value',
    'policy:project_pool'
  )
  fireEvent.click(screen.getByTestId(`${prefix}-environment`))
  fireEvent.click(await screen.findByTestId(`${prefix}-environment-option-1`))
  await waitFor(() =>
    expect(screen.getByTestId(`${prefix}-model`)).toHaveValue(modelValue(codexModel))
  )
  fireEvent.click(screen.getByTestId(`${dialog}-tab-basic`))
}

function setRichInputValue(testId: string, value: string) {
  const editor = screen.getByTestId(testId) as HTMLElement & { value: string }
  act(() => {
    editor.value = value
  })
}

describe('weworkProjectAgentConfigurationHost', () => {
  it('edits a cloud project definition with the same native Agent form and preserves execution bindings', async () => {
    const agent = {
      id: 'cloud-native-agent',
      name: 'Imported Agent',
      runtime: 'codex',
      executionPolicy: { mode: 'fixed', environment_id: '1' },
      modelPolicy: { mode: 'fixed', model: codexModel },
      capabilityMode: 'manual',
      systemPrompt: 'Original prompt',
      additionalSkills: [{ name: 'review', namespace: 'default' }],
      mcpServers: { ReviewServer: { command: 'review', env: { API_KEY_NAME: 'value' } } },
      plugins: [],
      executionEnvironment: 'cloud',
      executionMode: 'manual_approval',
      executionDeviceId: 'cloud-device',
      workspacePolicy: 'git_worktree',
      maxConcurrentExecutions: 4,
      visibility: 'creator_admin',
      version: 7,
    }
    const update = vi.fn<
      (projectId: string, agentId: string, input: Record<string, unknown>) => Promise<typeof agent>
    >(async () => agent)
    const list = vi.fn(async () => [agent])
    const host = createWeworkProjectAgentConfigurationHost(
      {
        listEnvironments: runnerCatalog(),
        listNativeModels: async (environment: RunnerEnvironment) => environment,
        listModels: vi.fn(async () => []),
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      { agents: { list, update, create: vi.fn() }, modelApi: {} as never, name: 'Cloud project' }
    )
    const onSaved = vi.fn(async () => undefined)
    render(
      host.renderProjectAgentEditor!({
        projectId: 'cloud-project',
        resourceId: agent.id,
        onClose: vi.fn(),
        onSaved,
      })
    )
    await waitFor(() =>
      expect(screen.getByTestId('cloud-project-chat-agent-display-name')).toHaveValue(agent.name)
    )
    fireEvent.change(screen.getByTestId('cloud-project-chat-agent-display-name'), {
      target: { value: 'Edited Agent' },
    })
    setRichInputValue('cloud-project-chat-agent-system-prompt', 'Updated prompt')
    fireEvent.click(screen.getByTestId('cloud-project-chat-agent-save'))
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(list).toHaveBeenCalledWith('cloud-project', undefined)
    expect(update).toHaveBeenCalledWith(
      'cloud-project',
      agent.id,
      expect.objectContaining({
        name: 'Edited Agent',
        systemPrompt: 'Updated prompt',
        version: 7,
        executionPolicy: agent.executionPolicy,
        modelPolicy: agent.modelPolicy,
        capabilityMode: 'manual',
        additionalSkills: agent.additionalSkills,
        mcpServers: agent.mcpServers,
        maxConcurrentExecutions: 4,
      })
    )
    const input = update.mock.calls[0][2]
    for (const field of [
      'executionEnvironment',
      'executionMode',
      'executionDeviceId',
      'workspacePolicy',
      'displayName',
      'namespace',
      'allowedModels',
    ]) {
      expect(input).not.toHaveProperty(field)
    }
    expect(host.renderLocalAgentCreator).toBeUndefined()
  })

  it('creates an Agent from the basic tab using the first cloud model without device discovery', async () => {
    const cloudModel = {
      name: 'cloud-model',
      type: 'public' as const,
      namespace: 'default',
      resourceUserId: 1,
      config: { protocol: 'openai-responses' },
    }
    const createAgent = vi.fn(async () => ({ id: 53, name: 'review', displayName: 'Review' }))
    const api = {
      listEnvironments: runnerCatalog(),
      listModels: vi.fn(async () => [cloudModel, { ...cloudModel, name: 'second-cloud-model' }]),
      listNativeModels: vi.fn(async (environment: RunnerEnvironment) => environment),
      listSkills: vi.fn(async () => []),
      createAgent,
    } as unknown as ReturnType<typeof createAgentResourceApi>
    const host = createWeworkProjectAgentConfigurationHost(api)
    render(
      host.renderAgentCreator!({
        namespace: 'default',
        projectId: 'project',
        onClose: vi.fn(),
        onCreated: vi.fn(async () => undefined),
        workspaceName: 'Personal',
      })
    )
    expect(api.listEnvironments).not.toHaveBeenCalled()
    expect(api.listModels).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.getByTestId('wework-agent-resource-create')).toBeEnabled())
    expect(screen.getByTestId('wework-agent-resource-creator-tab-basic')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('wework-agent-resource-creator-runtime-summary')).toHaveTextContent(
      'cloud-model'
    )
    expect(screen.getByTestId('wework-agent-environment')).toHaveAttribute(
      'data-value',
      'policy:project_pool'
    )
    fireEvent.click(screen.getByTestId('wework-agent-resource-create'))
    await waitFor(() =>
      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          executionPolicy: { mode: 'project_pool' },
          modelPolicy: {
            mode: 'fixed',
            model: {
              runtime: 'codex',
              source: 'cloud',
              provider: 'openai-responses',
              model_id: 'cloud-model',
              cloud_model: {
                name: 'cloud-model',
                type: 'public',
                namespace: 'default',
                resource_user_id: 1,
              },
            },
          },
        })
      )
    )
    expect(api.listEnvironments).not.toHaveBeenCalled()
    expect(api.listNativeModels).not.toHaveBeenCalled()
  })

  it('updates an open prompt Skill menu when its deferred catalog arrives', async () => {
    let resolveSkills!: (skills: unknown[]) => void
    const api = {
      listModels: vi.fn(async () => []),
      listSkills: vi.fn(
        () =>
          new Promise<unknown[]>(resolve => {
            resolveSkills = resolve
          })
      ),
    } as unknown as ReturnType<typeof createAgentResourceApi>
    const host = createWeworkProjectAgentConfigurationHost(api)
    render(
      host.renderAgentCreator!({
        namespace: 'default',
        workspaceName: 'Personal',
        onClose: vi.fn(),
        onCreated: vi.fn(),
      })
    )
    const editor = screen.getByTestId('wework-agent-system-prompt')
    fireEvent.focus(editor)
    setRichInputValue('wework-agent-system-prompt', '$')
    fireEvent.keyUp(editor, { key: '$' })
    await waitFor(() => expect(api.listSkills).toHaveBeenCalledOnce())
    await act(async () =>
      resolveSkills([
        { id: 7, name: 'review', namespace: 'default', displayName: 'Review', visible: true },
      ])
    )
    expect(await screen.findByTestId('local-skill-option-review')).toBeVisible()
  })

  it('preserves prompt and manual capabilities across tabs and exposes runtime conflicts on the basic tab', async () => {
    const otherModel = { ...codexModel, model_id: 'other-model' }
    const createAgent = vi.fn(async () => ({ id: 53, name: 'review', displayName: 'Review' }))
    const api = {
      listNativeModels: async (environment: RunnerEnvironment) => environment,
      listEnvironments: vi.fn(async () => [
        ...runnerEnvironments,
        {
          ...runnerEnvironments[0],
          id: '2',
          name: 'Other runner',
          models: [
            {
              ...otherModel,
              label: 'Other model',
              local_model_id: 'other-model',
              account_label: 'Other account',
              is_default: true,
            },
          ],
        },
      ]),
      listModels: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      createAgent,
    } as unknown as ReturnType<typeof createAgentResourceApi>
    const host = createWeworkProjectAgentConfigurationHost(api)
    render(
      host.renderAgentCreator!({
        namespace: 'default',
        onClose: vi.fn(),
        onCreated: vi.fn(async () => undefined),
        workspaceName: 'Personal',
      })
    )
    setRichInputValue('wework-agent-system-prompt', 'Keep this draft.')
    fireEvent.click(screen.getByTestId('wework-agent-resource-creator-advanced-toggle'))
    fireEvent.click(screen.getByTestId('wework-agent-capability-mode-manual'))
    fireEvent.change(screen.getByTestId('wework-agent-mcp'), {
      target: { value: '{"browser":{"command":"node"}}' },
    })
    fireEvent.click(screen.getByTestId('wework-agent-resource-creator-runtime-summary'))
    expect(screen.getByTestId('wework-agent-environment')).toHaveAttribute(
      'data-value',
      'policy:project_pool'
    )
    fireEvent.click(screen.getByTestId('wework-agent-environment'))
    fireEvent.click(await screen.findByTestId('wework-agent-environment-option-1'))
    expect(screen.queryByTestId('wework-agent-execution-policy')).not.toBeInTheDocument()
    expect(screen.getByTestId('wework-agent-environment')).toHaveAttribute('data-value', '1')
    await waitFor(() =>
      expect(screen.getByTestId('wework-agent-model')).toHaveValue(modelValue(codexModel))
    )
    fireEvent.click(screen.getByTestId('wework-agent-environment'))
    fireEvent.click(await screen.findByTestId('wework-agent-environment-option-2'))
    expect(screen.getByTestId('wework-agent-model')).toHaveValue('')
    expect(screen.getByTestId('wework-agent-resource-create')).toBeDisabled()
    fireEvent.keyDown(screen.getByTestId('wework-agent-resource-creator-tab-runtime'), {
      key: 'Home',
    })
    expect(screen.getByTestId('wework-agent-resource-creator-tab-basic')).toHaveFocus()
    expect(screen.getByTestId('wework-agent-resource-create')).toBeDisabled()
    expect(screen.getByTestId('wework-agent-system-prompt')).toHaveValue('Keep this draft.')
    expect(screen.getByTestId('wework-agent-capability-mode-manual')).toBeChecked()
    expect(screen.getByTestId('wework-agent-mcp')).toHaveValue('{"browser":{"command":"node"}}')
    fireEvent.keyDown(screen.getByTestId('wework-agent-resource-creator-tab-basic'), {
      key: 'ArrowRight',
    })
    expect(screen.getByTestId('wework-agent-resource-creator-tab-runtime')).toHaveFocus()
    fireEvent.change(screen.getByTestId('wework-agent-model'), {
      target: { value: modelValue(otherModel) },
    })
    expect(screen.getByTestId('wework-agent-resource-creator-runtime-summary')).toHaveTextContent(
      'Other runner · Other model'
    )
    fireEvent.click(screen.getByTestId('wework-agent-resource-creator-tab-basic'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('wework-agent-resource-create'))
    await waitFor(() =>
      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          executionPolicy: { mode: 'fixed', environment_id: '2' },
          modelPolicy: { mode: 'fixed', model: otherModel },
          capabilityMode: 'manual',
          systemPrompt: 'Keep this draft.',
          mcpServers: { browser: { command: 'node' } },
        })
      )
    )
  })
  it('renders a compact Agent picker dialog and focuses its search field', () => {
    const onClose = vi.fn()

    render(
      weworkProjectAgentConfigurationHost.renderDialog({
        busy: false,
        closeLabel: '关闭',
        description: '选择已有智能体，或新建智能体。',
        onClose,
        testIds: {
          backdrop: 'agent-backdrop',
          close: 'agent-close',
          dialog: 'agent-dialog',
        },
        title: '添加智能体',
        children: <input aria-label="搜索智能体" type="search" />,
      })
    )

    expect(screen.getByTestId('agent-dialog')).toHaveClass(
      'max-w-[520px]',
      'rounded-[20px]',
      'bg-popover'
    )
    expect(screen.getByRole('searchbox', { name: '搜索智能体' })).toHaveFocus()

    fireEvent.click(screen.getByTestId('agent-close'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('traps focus, restores the trigger and blocks dismissal during submission', () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const onClose = vi.fn()
    const props = {
      busy: true,
      closeLabel: '关闭',
      description: '选择一个智能体',
      onClose,
      testIds: { backdrop: 'busy-backdrop', close: 'busy-close', dialog: 'busy-dialog' },
      title: '添加智能体',
      children: <input aria-label="搜索智能体" type="search" />,
    }
    const { rerender, unmount } = render(weworkProjectAgentConfigurationHost.renderDialog(props))
    const search = screen.getByRole('searchbox')
    expect(search).toHaveFocus()
    fireEvent.keyDown(search, { key: 'Tab' })
    expect(search).toHaveFocus()
    fireEvent.keyDown(search, { key: 'Escape' })
    fireEvent.mouseDown(screen.getByTestId('busy-backdrop'))
    expect(screen.getByTestId('busy-close')).toBeDisabled()
    expect(onClose).not.toHaveBeenCalled()
    rerender(weworkProjectAgentConfigurationHost.renderDialog({ ...props, busy: false }))
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    unmount()
    expect(trigger).toHaveFocus()
    trigger.remove()
  })

  it('supports reusing existing Agents alongside the resource-library form', () => {
    const api = {
      listNativeModels: async (environment: RunnerEnvironment) => environment,
      listEnvironments: runnerCatalog(),
      listModels: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
    } as unknown as ReturnType<typeof createAgentResourceApi>
    const host = createWeworkProjectAgentConfigurationHost(api)

    expect(host.supportsExistingAgentSelection).toBe(true)
    expect(host.renderAgentCreator).toBeTypeOf('function')
    expect(host.renderAgentEditor).toBeTypeOf('function')
  })

  it('uses the real unified resource creator contract and returns the created Team reference', async () => {
    const onCreated = vi.fn(async () => undefined)
    const createAgent = vi.fn(async () => ({
      id: 52,
      name: 'review-agent',
      displayName: 'Review Agent',
      namespace: 'workspace-alpha',
    }))
    const api = {
      listNativeModels: async (environment: RunnerEnvironment) => environment,
      listEnvironments: runnerCatalog(),
      listModels: vi.fn(async () => [
        {
          name: 'desktop-e2e-public-model',
          type: 'public',
          displayName: 'Desktop E2E',
          namespace: 'default',
        },
      ]),
      listSkills: vi.fn(async () => [
        {
          id: 7,
          name: 'codex-review',
          namespace: 'workspace-alpha',
          description: '',
          displayName: 'Codex Review',
          bindShells: ['Codex'],
          visible: true,
          is_active: true,
          is_public: false,
          user_id: 1,
        },
        {
          id: 8,
          name: 'claude-review',
          namespace: 'workspace-alpha',
          description: '',
          displayName: 'Claude Review',
          bindShells: ['ClaudeCode'],
          visible: true,
          is_active: true,
          is_public: false,
          user_id: 1,
        },
      ]),
      createAgent,
    } as unknown as ReturnType<typeof createAgentResourceApi>
    const plugin = {
      id: 'quality-gate@team-market',
      pluginName: 'quality-gate',
      marketplaceId: 'team-market',
      displayName: 'Quality Gate',
      description: '检查提交质量并阻止不合格变更',
    }
    const pluginApi = {
      listPlugins: vi.fn(async () => [plugin]),
    }
    const host = createWeworkProjectAgentConfigurationHost(api, undefined, undefined, pluginApi)

    render(
      host.renderAgentCreator!({
        namespace: 'workspace-alpha',
        onClose: vi.fn(),
        onCreated,
        ownerOptions: [
          { namespace: 'default', label: '个人空间' },
          { namespace: 'workspace-alpha', label: 'Alpha Space' },
          { namespace: 'engineering', label: 'Engineering' },
        ],
        workspaceName: 'Alpha Space',
      })
    )

    expect(screen.getByTestId('wework-agent-resource-creator')).toHaveAttribute(
      'data-agent-form',
      'shared'
    )
    expect(screen.queryByTestId('wework-agent-resource-name')).not.toBeInTheDocument()
    expect(screen.queryByTestId('wework-agent-runtime')).not.toBeInTheDocument()
    expect(screen.getByTestId('wework-agent-resource-creator-tab-basic')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('wework-agent-environment')).not.toBeVisible()
    expect(screen.getByTestId('wework-agent-owner')).toHaveValue('workspace-alpha')
    fireEvent.change(screen.getByTestId('wework-agent-owner'), {
      target: { value: 'engineering' },
    })
    expect(screen.getByText('使用环境能力')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('wework-agent-resource-creator-advanced-toggle'))
    await waitFor(() =>
      expect(screen.getByTestId('wework-agent-capability-mode-follow')).toBeChecked()
    )
    fireEvent.click(screen.getByTestId('wework-agent-capability-mode-manual'))
    fireEvent.click(screen.getByTestId('wework-agent-skills-add'))
    expect(screen.getByText('Codex Review')).toBeInTheDocument()
    expect(screen.getByText('Claude Review')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('wework-agent-plugins-add')).toBeEnabled())
    fireEvent.click(screen.getByTestId('wework-agent-plugins-add'))
    expect(screen.getByText('Quality Gate')).toBeInTheDocument()
    expect(screen.getByText('检查提交质量并阻止不合格变更')).toBeInTheDocument()
    fireEvent.pointerDown(screen.getByTestId('wework-agent-system-prompt'))
    expect(screen.queryByTestId('wework-agent-plugins-picker')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('wework-agent-plugins-add'))
    expect(screen.getByTestId('wework-agent-resource-create')).toBeDisabled()

    fireEvent.change(screen.getByTestId('wework-agent-display-name'), {
      target: { value: 'Review Agent' },
    })
    await selectProjectNativeModel('wework-agent')
    expect(screen.getByTestId('wework-agent-resource-create')).toBeEnabled()
    fireEvent.click(screen.getByTestId('wework-agent-skills-add'))
    fireEvent.click(screen.getByTestId('wework-agent-skill-7'))
    fireEvent.click(screen.getByTestId(`wework-agent-plugin-${plugin.id}`))
    setRichInputValue('wework-agent-system-prompt', 'Review the implementation.')
    fireEvent.change(screen.getByTestId('wework-agent-mcp'), {
      target: {
        value: '{"browser":{"command":"node","args":["browser.mjs"]}}',
      },
    })
    fireEvent.click(screen.getByTestId('wework-agent-resource-create'))

    await waitFor(() =>
      expect(createAgent).toHaveBeenCalledWith({
        name: expect.stringMatching(/^agent-[a-z0-9]+-[a-z0-9]{6}$/),
        displayName: 'Review Agent',
        namespace: 'engineering',
        capabilityMode: 'manual',
        runtime: 'Codex',
        executionPolicy: { mode: 'fixed', environment_id: '1' },
        modelPolicy: { mode: 'fixed', model: codexModel },
        model: { name: codexModel.model_id, type: 'runtime' },
        systemPrompt: 'Review the implementation.',
        skills: [
          {
            skillId: 7,
            name: 'codex-review',
            namespace: 'workspace-alpha',
            isPublic: false,
          },
        ],
        plugins: [plugin],
        mcpServers: {
          browser: {
            command: 'node',
            args: ['browser.mjs'],
          },
        },
      })
    )
    expect(onCreated).toHaveBeenCalledWith({
      name: 'Review Agent',
      teamId: 52,
    })
  })

  it('keeps model-backed Agent creation available when optional Skill loading fails', async () => {
    const createAgent = vi.fn(async () => ({
      id: 53,
      name: 'offline-agent',
      displayName: 'Offline Agent',
      namespace: 'default',
    }))
    const api = {
      listNativeModels: async (environment: RunnerEnvironment) => environment,
      listEnvironments: runnerCatalog(),
      listModels: vi.fn(async () => [
        {
          name: 'desktop-e2e-public-model',
          type: 'public',
          displayName: 'Desktop E2E',
          namespace: 'default',
        },
      ]),
      listSkills: vi.fn(async () => {
        throw new Error('Skill catalog unavailable')
      }),
      createAgent,
    } as unknown as ReturnType<typeof createAgentResourceApi>
    const host = createWeworkProjectAgentConfigurationHost(api)

    render(
      host.renderAgentCreator!({
        namespace: 'default',
        onClose: vi.fn(),
        onCreated: vi.fn(async () => undefined),
        workspaceName: 'Local Space',
      })
    )

    fireEvent.click(screen.getByTestId('wework-agent-resource-creator-advanced-toggle'))
    fireEvent.click(screen.getByTestId('wework-agent-capability-mode-manual'))
    await waitFor(() => expect(screen.getByText('Skill catalog unavailable')).toBeInTheDocument())
    await selectProjectNativeModel('wework-agent')

    expect(screen.getByTestId('wework-agent-resource-create')).toBeEnabled()
    fireEvent.click(screen.getByTestId('wework-agent-resource-create'))

    await waitFor(() =>
      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: expect.stringMatching(/^agent-[a-z0-9]+-[a-z0-9]{6}$/),
          executionPolicy: { mode: 'fixed', environment_id: '1' },
          modelPolicy: { mode: 'fixed', model: codexModel },
          model: { name: codexModel.model_id, type: 'runtime' },
          skills: [],
        })
      )
    )
  })

  it('edits the Agent resource behind a configured project Agent', async () => {
    const onSaved = vi.fn(async () => undefined)
    const getAgent = vi.fn(async () => ({
      teamId: 52,
      botId: 71,
      name: 'review-agent',
      displayName: 'Review Agent',
      namespace: 'workspace-alpha',
      runtime: 'ClaudeCode' as const,
      shellName: 'ClaudeCode',
      executionPolicy: { mode: 'fixed', environment_id: '1' },
      modelPolicy: { mode: 'fixed', model: claudeModel },
      model: {
        name: 'desktop-e2e-public-model',
        type: 'public' as const,
        namespace: 'default',
      },
      systemPrompt: 'Review the implementation.',
      skills: [
        {
          skillId: 8,
          name: 'claude-review',
          namespace: 'workspace-alpha',
          isPublic: false,
        },
      ],
      plugins: [],
      mcpServers: { browser: { command: 'node' } },
      capabilityMode: 'manual' as const,
    }))
    const updateAgent = vi.fn(async () => ({
      id: 52,
      name: 'review-agent',
      displayName: 'Reviewer',
      namespace: 'workspace-alpha',
    }))
    const api = {
      listNativeModels: async (environment: RunnerEnvironment) => environment,
      listEnvironments: runnerCatalog(),
      listModels: vi.fn(async () => [
        {
          name: 'desktop-e2e-public-model',
          type: 'public',
          displayName: 'Desktop E2E',
          namespace: 'default',
        },
      ]),
      listSkills: vi.fn(async () => [
        {
          id: 7,
          name: 'codex-review',
          namespace: 'workspace-alpha',
          description: '',
          displayName: 'Codex Review',
          bindShells: ['Codex'],
          visible: true,
          is_active: true,
          is_public: false,
          user_id: 1,
        },
        {
          id: 8,
          name: 'claude-review',
          namespace: 'workspace-alpha',
          description: '',
          displayName: 'Claude Review',
          bindShells: ['ClaudeCode'],
          visible: true,
          is_active: true,
          is_public: false,
          user_id: 1,
        },
      ]),
      createAgent: vi.fn(),
      getAgent,
      updateAgent,
    } as unknown as ReturnType<typeof createAgentResourceApi>
    const host = createWeworkProjectAgentConfigurationHost(api)

    render(
      host.renderAgentEditor!({
        agent: { teamId: 52 },
        namespace: 'workspace-alpha',
        onClose: vi.fn(),
        onSaved,
        workspaceName: 'Alpha Space',
      })
    )

    await waitFor(() => expect(getAgent).toHaveBeenCalledWith(52))
    await waitFor(() =>
      expect(screen.getByTestId('wework-agent-system-prompt')).toHaveValue(
        'Review the implementation.'
      )
    )
    expect(screen.queryByTestId('wework-agent-resource-name')).not.toBeInTheDocument()
    expect(screen.queryByTestId('wework-agent-runtime')).not.toBeInTheDocument()
    // The model and Skill catalogs load independently of the Agent detail, so
    // their prefill lands in a later commit than the system prompt.
    await waitFor(() =>
      expect(screen.getByTestId('wework-agent-model')).toHaveValue(modelValue(claudeModel))
    )
    fireEvent.click(screen.getByTestId('wework-agent-resource-creator-advanced-toggle'))
    await waitFor(() => expect(screen.getByTestId('wework-agent-skills-add')).toBeEnabled())
    fireEvent.click(screen.getByTestId('wework-agent-skills-add'))
    await waitFor(() => expect(screen.getByTestId('wework-agent-skill-8')).toBeChecked())
    expect(screen.getByTestId('wework-agent-skill-7')).not.toBeChecked()

    fireEvent.change(screen.getByTestId('wework-agent-display-name'), {
      target: { value: 'Reviewer' },
    })
    setRichInputValue('wework-agent-system-prompt', 'Review and summarize.')
    fireEvent.click(screen.getByTestId('wework-agent-resource-create'))

    await waitFor(() =>
      expect(updateAgent).toHaveBeenCalledWith(
        { teamId: 52, botId: 71 },
        expect.objectContaining({
          name: 'review-agent',
          displayName: 'Reviewer',
          namespace: 'workspace-alpha',
          capabilityMode: 'manual',
          runtime: 'ClaudeCode',
          systemPrompt: 'Review and summarize.',
          skills: [
            {
              skillId: 8,
              name: 'claude-review',
              namespace: 'workspace-alpha',
              isPublic: false,
            },
          ],
          mcpServers: { browser: { command: 'node' } },
        })
      )
    )
    expect(onSaved).toHaveBeenCalledWith({ name: 'Reviewer', teamId: 52 })
  })

  it('uses the cloud Agent domain fields for a local Agent', async () => {
    const onCreated = vi.fn(async () => undefined)
    const create = vi.fn(async () => ({ id: 'local-agent-1' }))
    const localAgentApi = {
      listNativeModels: async (environment: RunnerEnvironment) => environment,
      listEnvironments: runnerCatalog(),
      listModels: vi.fn(async () => []),
      list: vi.fn(async () => []),
      create,
      update: vi.fn(),
      archive: vi.fn(),
    }
    const modelApi = {
      listModels: vi.fn(async () => ({
        data: [{ name: 'gpt-5', displayName: 'GPT-5', type: 'public' }],
      })),
    }
    const skill = {
      id: 12,
      name: 'review',
      namespace: 'default',
      description: '',
      displayName: 'Review',
      is_active: true,
      is_public: false,
      user_id: 1,
    }
    const agentResourceApi = {
      listSkills: vi.fn(async () => [skill]),
    }
    const plugin = {
      id: 'quality-gate@team-market',
      pluginName: 'quality-gate',
      marketplaceId: 'team-market',
      displayName: 'Quality Gate',
    }
    const pluginApi = {
      listPlugins: vi.fn(async () => [plugin]),
    }
    const deviceApi = {
      listDevices: vi.fn(async () => [
        {
          id: 1,
          device_id: 'local-device',
          name: 'My Mac',
          status: 'online',
          is_default: true,
          device_type: 'local',
          bind_shell: 'claudecode',
        },
      ]),
      listSkills: vi.fn(async () => [{ name: 'desktop-control' }]),
    }
    const host = createWeworkProjectAgentConfigurationHost(
      agentResourceApi as never,
      localAgentApi as never,
      modelApi as never,
      pluginApi,
      deviceApi as never
    )

    render(
      host.renderLocalAgentCreator!({
        onClose: vi.fn(),
        onCreated,
      })
    )

    expect(screen.getByTestId('cloud-project-chat-agent-editor')).toHaveAttribute(
      'data-agent-form',
      'shared'
    )
    expect(agentResourceApi.listSkills).not.toHaveBeenCalled()
    expect(pluginApi.listPlugins).not.toHaveBeenCalled()
    expect(screen.getByTestId('cloud-project-chat-agent-environment')).not.toBeVisible()
    expect(screen.queryByTestId('cloud-project-chat-agent-name')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-chat-agent-mode')).not.toBeInTheDocument()
    expect(screen.queryByText('仅展示当前在线的设备')).not.toBeInTheDocument()
    expect(screen.queryByText('我的本地')).not.toBeInTheDocument()
    fireEvent.change(screen.getByTestId('cloud-project-chat-agent-display-name'), {
      target: { value: '本地评审' },
    })
    await selectProjectNativeModel('cloud-project-chat-agent')
    fireEvent.click(screen.getByTestId('cloud-project-chat-agent-editor-advanced-toggle'))
    await waitFor(() => expect(agentResourceApi.listSkills).toHaveBeenCalledOnce())
    await waitFor(() => expect(pluginApi.listPlugins).toHaveBeenCalledWith(''))
    await waitFor(() =>
      expect(screen.getByTestId('cloud-project-chat-agent-capability-mode-follow')).toBeChecked()
    )
    expect(screen.getByTestId('cloud-project-chat-agent-device-capability-preview')).toBeVisible()
    expect(screen.getByText('My Mac')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('cloud-project-chat-agent-capability-mode-manual'))
    fireEvent.click(screen.getByTestId('cloud-project-chat-agent-skills-add'))
    fireEvent.click(screen.getByTestId(`cloud-project-chat-agent-skill-${skill.id}`))
    fireEvent.click(screen.getByTestId('cloud-project-chat-agent-plugins-add'))
    fireEvent.click(screen.getByTestId(`cloud-project-chat-agent-plugin-${plugin.id}`))
    expect(screen.getByTestId('cloud-project-chat-agent-save')).toBeEnabled()
    fireEvent.click(screen.getByTestId('cloud-project-chat-agent-save'))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        DEFAULT_WORK_ITEM_PROJECT_ID,
        expect.objectContaining({
          name: expect.stringMatching(/^agent-[a-z0-9]+-[a-z0-9]{6}$/),
          displayName: '本地评审',
          runtime: 'codex',
          model: 'gpt-5',
          executionPolicy: { mode: 'fixed', environment_id: '1' },
          modelPolicy: { mode: 'fixed', model: codexModel },
          executionMode: 'auto',
          executionEnvironment: 'local',
          executionDeviceId: null,
          capabilityMode: 'manual',
          additionalSkills: [
            {
              skillId: 12,
              name: 'review',
              namespace: 'default',
              isPublic: false,
            },
          ],
          plugins: [plugin],
        })
      )
    )
    expect(onCreated).toHaveBeenCalledOnce()
  })

  it('saves an existing manual-approval agent with automatic execution', async () => {
    const agent = {
      id: 'manual-agent',
      executionPolicy: { mode: 'fixed', environment_id: '1' },
      modelPolicy: { mode: 'fixed', model: codexModel },
      name: 'Existing agent',
      displayName: 'Existing Agent',
      runtime: 'codex',
      model: 'gpt-5',
      capabilityDescription: '',
      capabilityMode: 'follow_device',
      systemPrompt: '',
      additionalSkills: [],
      mcpServers: {},
      plugins: [],
      executionMode: 'manual_approval',
      maxConcurrentExecutions: 1,
      visibility: 'creator_admin',
      version: 3,
    }
    const update = vi.fn(async () => agent)
    const host = createWeworkProjectAgentConfigurationHost(
      { listSkills: vi.fn(async () => []) } as never,
      {
        listNativeModels: async (environment: RunnerEnvironment) => environment,
        listEnvironments: runnerCatalog(),
        listModels: vi.fn(async () => []),
        list: vi.fn(async () => [agent]),
        create: vi.fn(),
        update,
        archive: vi.fn(),
      } as never,
      {
        listModels: vi.fn(async () => ({
          data: [{ name: 'gpt-5', displayName: 'GPT-5', type: 'public' }],
        })),
      } as never
    )
    const onSaved = vi.fn(async () => undefined)
    render(host.renderProjectAgentEditor!({ resourceId: agent.id, onClose: vi.fn(), onSaved }))
    await waitFor(() =>
      expect(screen.getByTestId('cloud-project-chat-agent-display-name')).toHaveValue(
        agent.displayName
      )
    )
    expect(screen.queryByTestId('cloud-project-chat-agent-name')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-chat-agent-mode')).not.toBeInTheDocument()
    expect(screen.queryByText('手动批准')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('cloud-project-chat-agent-save'))
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        DEFAULT_WORK_ITEM_PROJECT_ID,
        agent.id,
        expect.objectContaining({
          version: 3,
          executionMode: 'auto',
        })
      )
    )
    expect(onSaved).toHaveBeenCalledOnce()
  })

  it('configures an allowed model range for the current device agent', async () => {
    const agent = {
      id: 'device-agent',
      name: 'current-device-agent',
      displayName: '当前设备智能体',
      runtime: 'codex',
      model: null,
      modelType: null,
      modelNamespace: 'default',
      allowedModels: [
        {
          name: 'retired-model',
          type: 'runtime',
          namespace: 'default',
        },
      ],
      capabilityDescription: '使用当前设备的模型、技能和工具。',
      capabilityMode: 'follow_device',
      systemPrompt: '',
      additionalSkills: [],
      mcpServers: {},
      plugins: [],
      executionMode: 'auto',
      maxConcurrentExecutions: 1,
      visibility: 'creator_admin',
      version: 4,
    }
    const update = vi.fn(async () => agent)
    const host = createWeworkProjectAgentConfigurationHost(
      { listSkills: vi.fn(async () => []) } as never,
      {
        listNativeModels: async (environment: RunnerEnvironment) => environment,
        listEnvironments: runnerCatalog(),
        listModels: vi.fn(async () => []),
        list: vi.fn(async () => [agent]),
        create: vi.fn(),
        update,
        archive: vi.fn(),
      } as never,
      {
        listModels: vi.fn(async () => ({
          data: [
            { name: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', type: 'runtime' },
            { name: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', type: 'runtime' },
          ],
        })),
      } as never
    )
    render(
      host.renderProjectAgentEditor!({
        resourceId: agent.id,
        onClose: vi.fn(),
        onSaved: vi.fn(async () => undefined),
      })
    )

    await waitFor(() =>
      expect(screen.getByTestId('cloud-project-chat-agent-display-name')).toHaveValue(
        agent.displayName
      )
    )
    fireEvent.click(screen.getByTestId('cloud-project-chat-agent-editor-tab-runtime'))
    expect(screen.getByTestId('cloud-project-chat-agent-models')).toBeVisible()
    expect(screen.queryByTestId('cloud-project-chat-agent-model')).not.toBeInTheDocument()
    expect(screen.queryByText('默认')).not.toBeInTheDocument()
    expect(
      screen.getByTestId('cloud-project-chat-agent-model-unavailable-retired-model')
    ).toHaveTextContent('retired-model（当前不可用）')
    fireEvent.click(screen.getByTestId('cloud-project-chat-agent-model-remove-retired-model'))
    fireEvent.click(await screen.findByTestId('cloud-project-chat-agent-model-gpt-5.6-sol'))
    fireEvent.click(screen.getByTestId('cloud-project-chat-agent-model-gpt-5.6-luna'))
    fireEvent.click(screen.getByTestId('cloud-project-chat-agent-save'))

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        DEFAULT_WORK_ITEM_PROJECT_ID,
        agent.id,
        expect.objectContaining({
          version: 4,
          model: 'gpt-5.6-sol',
          modelType: 'runtime',
          modelNamespace: 'default',
          allowedModels: [
            { name: 'gpt-5.6-sol', type: 'runtime', namespace: 'default' },
            { name: 'gpt-5.6-luna', type: 'runtime', namespace: 'default' },
          ],
        })
      )
    )
  })
})

it('creates portable template resources without carrying source identity or credentials', async () => {
  const createAgent = vi.fn(async () => ({ id: 98, name: 'new-agent' }))
  const getAgent = vi.fn(async () => ({
    runtime: 'Codex',
    displayName: 'Reviewer',
    name: 'reviewer',
    systemPrompt: 'Check acceptance with evidence.',
  }))
  const host = createWeworkProjectAgentConfigurationHost({
    createAgent,
    getAgent,
  } as unknown as ReturnType<typeof createAgentResourceApi>)
  const created = await host.createTemplateAgent!(
    {
      key: 'review',
      name: 'Reviewer',
      runtime: 'codex',
      systemPrompt: 'Check acceptance with evidence.',
      capabilityDescription: 'Review',
    },
    'destination',
    {
      executionPolicy: { mode: 'fixed', environment_id: 'target' },
      modelPolicy: {
        mode: 'fixed',
        model: { runtime: 'codex', provider: 'openai', model_id: 'target-default' },
      },
    }
  )
  expect(created).toEqual({ id: '98', name: 'Reviewer' })
  expect(createAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      namespace: 'destination',
      runtime: 'Codex',
      systemPrompt: 'Check acceptance with evidence.',
      capabilityMode: 'follow_device',
      model: { name: '' },
      plugins: [],
      mcpServers: {},
    })
  )
  expect(await host.readTemplateAgent!(98)).toMatchObject({
    name: 'Reviewer',
    runtime: 'codex',
    systemPrompt: 'Check acceptance with evidence.',
  })
})

it('resolves explicit destination defaults instead of importing source model or device identities', async () => {
  const local = {
    listRunnerEnvironments: vi.fn(async () => [
      {
        id: 'destination',
        device_key: 'destination',
        models: [
          {
            runtime: 'codex',
            provider: 'openai',
            model_id: 'default-model',
            is_default: true,
            source: 'native',
          },
          { runtime: 'codex', provider: 'other', model_id: 'another-model', is_default: false },
        ],
      },
    ]),
  } as unknown as Parameters<typeof createWeworkProjectAgentConfigurationHost>[1]
  const host = createWeworkProjectAgentConfigurationHost(undefined, local)
  expect(await host.resolveTemplateAgentRouting!('codex', 'local', 'project')).toEqual({
    executionPolicy: { mode: 'fixed', environment_id: 'destination' },
    modelPolicy: {
      mode: 'fixed',
      model: { runtime: 'codex', provider: 'openai', model_id: 'default-model', source: 'native' },
    },
  })
  await expect(
    host.resolveTemplateAgentRouting!('claude_code', 'local', 'project')
  ).rejects.toThrow('template_model_default_unavailable')
})

it.each([0, 2])(
  'refuses to guess a model when %i destination defaults are configured',
  async count => {
    const local = {
      listRunnerEnvironments: vi.fn(async () => [
        {
          id: 'destination',
          models: Array.from({ length: 2 }, (_, index) => ({
            runtime: 'codex',
            provider: 'openai',
            model_id: `model-${index}`,
            is_default: index < count,
          })),
        },
      ]),
    } as unknown as Parameters<typeof createWeworkProjectAgentConfigurationHost>[1]
    const host = createWeworkProjectAgentConfigurationHost(undefined, local)
    await expect(host.resolveTemplateAgentRouting!('codex', 'local')).rejects.toThrow(
      'template_model_default_unavailable'
    )
  }
)

it('does not authorize a current device that the destination cloud project has not granted', async () => {
  const local = {
    listRunnerEnvironments: vi.fn(async () => [
      {
        id: 'local-device',
        device_key: 'device-key',
        models: [{ runtime: 'codex', provider: 'openai', model_id: 'default', is_default: true }],
      },
    ]),
  } as unknown as Parameters<typeof createWeworkProjectAgentConfigurationHost>[1]
  const listEnvironments = vi.fn(async () => [
    { id: '73', device_key: 'device-key', project_authorized: false, status: 'online' },
  ])
  const createAgent = vi.fn()
  const host = createWeworkProjectAgentConfigurationHost(
    { listEnvironments, createAgent } as unknown as ReturnType<typeof createAgentResourceApi>,
    local
  )
  await expect(host.resolveTemplateAgentRouting!('codex', 'cloud')).resolves.toMatchObject({
    executionPolicy: { mode: 'fixed', environment_id: '73' },
  })
  expect(listEnvironments).toHaveBeenCalledWith(undefined)
  await expect(
    host.resolveTemplateAgentRouting!('codex', 'cloud', 'private-project')
  ).rejects.toThrow('template_environment_unavailable')
  expect(listEnvironments).toHaveBeenCalledWith('private-project')
  expect(createAgent).not.toHaveBeenCalled()
})

it('matches the current APP device through its app device id', async () => {
  const local = {
    listRunnerEnvironments: vi.fn(async () => [
      {
        id: 'electron-current',
        device_key: 'electron-current',
        models: [{ runtime: 'codex', provider: 'openai', model_id: 'default', is_default: true }],
      },
    ]),
  } as unknown as Parameters<typeof createWeworkProjectAgentConfigurationHost>[1]
  const listEnvironments = vi.fn(async () => [
    {
      id: '73',
      device_key: 'app-record-73',
      app_device_id: 'electron-current',
      project_authorized: true,
      status: 'online',
    },
  ])
  const host = createWeworkProjectAgentConfigurationHost(
    { listEnvironments, createAgent: vi.fn() } as unknown as ReturnType<
      typeof createAgentResourceApi
    >,
    local
  )

  await expect(
    host.resolveTemplateAgentRouting!('codex', 'cloud', 'private-project')
  ).resolves.toMatchObject({
    executionPolicy: { mode: 'fixed', environment_id: '73' },
  })
})

it.each([
  {
    statuses: ['offline', 'online', 'offline'],
    grants: [false, false, false],
    projectId: undefined,
    expectedId: '2',
  },
  { statuses: ['online', 'offline'], grants: [true, true], projectId: 'project', expectedId: '1' },
  { statuses: ['offline'], grants: [true], projectId: undefined, expectedId: null },
  { statuses: ['online', 'online'], grants: [true, true], projectId: undefined, expectedId: null },
  {
    statuses: ['offline', 'online'],
    grants: [true, false],
    projectId: 'project',
    expectedId: null,
  },
])(
  'resolves only a unique online authorized alias: $statuses / $grants',
  async ({ statuses, grants, projectId, expectedId }) => {
    const host = createWeworkProjectAgentConfigurationHost(
      {
        listEnvironments: vi.fn(async () =>
          statuses.map((status, index) => ({
            id: String(index + 1),
            device_key: `app-record-${index + 1}`,
            app_device_id: 'electron-current',
            status,
            project_authorized: grants[index],
          }))
        ),
      } as unknown as ReturnType<typeof createAgentResourceApi>,
      {
        listRunnerEnvironments: vi.fn(async () => [
          {
            id: 'electron-current',
            device_key: 'electron-current',
            models: [
              { runtime: 'codex', provider: 'openai', model_id: 'default', is_default: true },
            ],
          },
        ]),
      } as unknown as Parameters<typeof createWeworkProjectAgentConfigurationHost>[1]
    )
    const routing = host.resolveTemplateAgentRouting!('codex', 'cloud', projectId)
    if (expectedId) {
      await expect(routing).resolves.toMatchObject({
        executionPolicy: { mode: 'fixed', environment_id: expectedId },
      })
    } else {
      await expect(routing).rejects.toThrow('template_environment_unavailable')
    }
  }
)
