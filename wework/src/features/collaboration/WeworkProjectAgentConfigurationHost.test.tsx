import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { createAgentResourceApi } from '@/api/agentResources'
import { DEFAULT_WORK_ITEM_PROJECT_ID } from '@/api/deliveries'
import {
  createWeworkProjectAgentConfigurationHost,
  weworkProjectAgentConfigurationHost,
} from './WeworkProjectAgentConfigurationHost'

function setRichInputValue(testId: string, value: string) {
  const editor = screen.getByTestId(testId) as HTMLElement & { value: string }
  act(() => {
    editor.value = value
  })
}

describe('weworkProjectAgentConfigurationHost', () => {
  it('renders the shared Agent form with Wework design-system controls', () => {
    const onClose = vi.fn()
    const onModeChange = vi.fn()

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
        children: (
          <>
            {weworkProjectAgentConfigurationHost.renderModePicker({
              onChange: onModeChange,
              options: [
                {
                  description: '使用已有智能体',
                  label: '已有智能体',
                  testId: 'mode-existing',
                  value: 'existing',
                },
                {
                  description: '使用资源库表单',
                  label: '新建智能体',
                  testId: 'mode-create',
                  value: 'create',
                },
              ],
              value: 'create',
            })}
            {weworkProjectAgentConfigurationHost.renderPrimaryAction({
              children: '创建智能体',
              disabled: false,
              onClick: vi.fn(),
              testId: 'agent-submit',
            })}
          </>
        ),
      })
    )

    expect(screen.getByTestId('agent-dialog')).toHaveClass(
      'max-w-4xl',
      'rounded-[20px]',
      'bg-popover'
    )
    expect(screen.getByTestId('mode-create-card')).toHaveClass(
      'border-focus',
      'bg-focus/5',
      'ring-1'
    )
    expect(screen.getByTestId('agent-submit')).toHaveClass('rounded-lg', 'bg-text-primary')

    fireEvent.click(screen.getByTestId('mode-existing'))
    expect(onModeChange).toHaveBeenCalledWith('existing')

    fireEvent.click(screen.getByTestId('agent-close'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('opens the resource-library form without exposing existing Agent selection', () => {
    const api = {
      listModels: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
    } as unknown as ReturnType<typeof createAgentResourceApi>
    const host = createWeworkProjectAgentConfigurationHost(api)

    expect(host.supportsExistingAgentSelection).toBe(false)
    expect(host.renderAgentCreator).toBeTypeOf('function')
    expect(host.renderAgentEditor).toBeTypeOf('function')
  })

  it('creates the default local Agent from the current device model', async () => {
    const defaultAgent = {
      id: 'local-agent-default',
      name: 'current-device-agent',
      displayName: '当前设备智能体',
    }
    const ensureDefault = vi.fn(async () => defaultAgent)
    const localAgentApi = {
      list: vi.fn(async () => []),
      ensureDefault,
      create: vi.fn(),
    }
    const localModelApi = {
      listModels: vi.fn(async () => ({
        data: [
          {
            name: 'gpt-5',
            displayName: 'GPT-5',
            type: 'public',
            namespace: 'default',
          },
        ],
      })),
    }
    const host = createWeworkProjectAgentConfigurationHost(
      undefined,
      localAgentApi as never,
      localModelApi as never
    )

    await expect(host.createDefaultLocalAgent?.()).resolves.toBe(defaultAgent.id)
    expect(ensureDefault).toHaveBeenCalledWith(
      DEFAULT_WORK_ITEM_PROJECT_ID,
      expect.objectContaining({
        name: 'current-device-agent',
        displayName: '当前设备智能体',
        model: 'gpt-5',
        capabilityMode: 'follow_device',
      })
    )
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
    expect(screen.getByTestId('wework-agent-owner')).toHaveValue('workspace-alpha')
    fireEvent.change(screen.getByTestId('wework-agent-owner'), {
      target: { value: 'engineering' },
    })
    expect(screen.getByText('能力：跟随运行设备')).toBeInTheDocument()
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
    fireEvent.change(screen.getByTestId('wework-agent-model'), {
      target: { value: '0' },
    })
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
        model: {
          name: 'desktop-e2e-public-model',
          type: 'public',
          namespace: 'default',
        },
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
    fireEvent.change(screen.getByTestId('wework-agent-model'), {
      target: { value: '0' },
    })

    expect(screen.getByTestId('wework-agent-resource-create')).toBeEnabled()
    fireEvent.click(screen.getByTestId('wework-agent-resource-create'))

    await waitFor(() =>
      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: expect.stringMatching(/^agent-[a-z0-9]+-[a-z0-9]{6}$/),
          model: {
            name: 'desktop-e2e-public-model',
            type: 'public',
            namespace: 'default',
          },
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
    await waitFor(() => expect(screen.getByTestId('wework-agent-model')).toHaveValue('0'))
    fireEvent.click(screen.getByTestId('wework-agent-resource-creator-advanced-toggle'))
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
    expect(agentResourceApi.listSkills).toHaveBeenCalledOnce()
    expect(pluginApi.listPlugins).toHaveBeenCalledWith('')
    expect(screen.queryByTestId('cloud-project-chat-agent-environment')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-chat-agent-name')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-chat-agent-mode')).not.toBeInTheDocument()
    expect(screen.queryByText('仅展示当前在线的设备')).not.toBeInTheDocument()
    expect(screen.queryByText('我的本地')).not.toBeInTheDocument()
    fireEvent.change(screen.getByTestId('cloud-project-chat-agent-display-name'), {
      target: { value: '本地评审' },
    })
    await waitFor(() =>
      expect(screen.getByTestId('cloud-project-chat-agent-model')).not.toBeDisabled()
    )
    fireEvent.change(screen.getByTestId('cloud-project-chat-agent-model'), {
      target: { value: 'gpt-5' },
    })
    fireEvent.click(screen.getByTestId('cloud-project-chat-agent-editor-advanced-toggle'))
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
          executionMode: 'auto',
          executionEnvironment: 'local',
          executionDeviceId: null,
          workspacePolicy: 'git_worktree',
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
      { list: vi.fn(async () => [agent]), create: vi.fn(), update, archive: vi.fn() } as never,
      {
        listModels: vi.fn(async () => ({
          data: [{ name: 'gpt-5', displayName: 'GPT-5', type: 'public' }],
        })),
      } as never
    )
    const onSaved = vi.fn(async () => undefined)
    render(host.renderLocalAgentEditor!({ resourceId: agent.id, onClose: vi.fn(), onSaved }))
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
          workspacePolicy: 'git_worktree',
        })
      )
    )
    expect(onSaved).toHaveBeenCalledOnce()
  })
})
