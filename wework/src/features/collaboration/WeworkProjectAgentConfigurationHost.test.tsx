import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { createAgentResourceApi } from '@/api/agentResources'
import { DEFAULT_WORK_ITEM_PROJECT_ID } from '@/api/deliveries'
import {
  createWeworkProjectAgentConfigurationHost,
  weworkProjectAgentConfigurationHost,
} from './WeworkProjectAgentConfigurationHost'

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

  it('keeps existing resources selectable alongside the resource-library form', () => {
    const api = {
      listModels: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
    } as unknown as ReturnType<typeof createAgentResourceApi>
    const host = createWeworkProjectAgentConfigurationHost(api)

    expect(host.supportsExistingAgentSelection).toBe(true)
    expect(host.supportsCrossLocationAgentSelection).toBe(true)
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
    const host = createWeworkProjectAgentConfigurationHost(api)

    render(
      host.renderAgentCreator!({
        namespace: 'workspace-alpha',
        onClose: vi.fn(),
        onCreated,
        workspaceName: 'Alpha Space',
      })
    )

    await waitFor(() => expect(screen.getByText('Codex Review')).toBeInTheDocument())
    expect(screen.getByText('Claude Review')).toBeInTheDocument()
    expect(screen.getByTestId('wework-agent-resource-create')).toBeDisabled()

    fireEvent.change(screen.getByTestId('wework-agent-runtime'), {
      target: { value: 'ClaudeCode' },
    })
    expect(screen.getByText('Codex Review')).toBeInTheDocument()
    expect(screen.getByText('Claude Review')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('wework-agent-resource-name'), {
      target: { value: 'review-agent' },
    })
    fireEvent.change(screen.getByTestId('wework-agent-display-name'), {
      target: { value: 'Review Agent' },
    })
    fireEvent.change(screen.getByTestId('wework-agent-model'), {
      target: { value: '0' },
    })
    expect(screen.getByTestId('wework-agent-resource-create')).toBeEnabled()
    fireEvent.click(screen.getByTestId('wework-agent-skill-8'))
    fireEvent.change(screen.getByTestId('wework-agent-system-prompt'), {
      target: { value: 'Review the implementation.' },
    })
    fireEvent.change(screen.getByTestId('wework-agent-mcp'), {
      target: {
        value: '{"browser":{"command":"node","args":["browser.mjs"]}}',
      },
    })
    fireEvent.click(screen.getByTestId('wework-agent-resource-create'))

    await waitFor(() =>
      expect(createAgent).toHaveBeenCalledWith({
        name: 'review-agent',
        displayName: 'Review Agent',
        namespace: 'workspace-alpha',
        runtime: 'ClaudeCode',
        model: {
          name: 'desktop-e2e-public-model',
          type: 'public',
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

    await waitFor(() => expect(screen.getByText('Skill catalog unavailable')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('wework-agent-resource-name'), {
      target: { value: 'offline-agent' },
    })
    fireEvent.change(screen.getByTestId('wework-agent-model'), {
      target: { value: '0' },
    })

    expect(screen.getByTestId('wework-agent-resource-create')).toBeEnabled()
    fireEvent.click(screen.getByTestId('wework-agent-resource-create'))

    await waitFor(() =>
      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'offline-agent',
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
      mcpServers: { browser: { command: 'node' } },
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
    expect(screen.getByTestId('wework-agent-resource-name')).toBeDisabled()
    expect(screen.getByTestId('wework-agent-resource-name')).toHaveValue('review-agent')
    expect(screen.getByTestId('wework-agent-runtime')).toHaveValue('ClaudeCode')
    // The model and Skill catalogs load independently of the Agent detail, so
    // their prefill lands in a later commit than the system prompt.
    await waitFor(() => expect(screen.getByTestId('wework-agent-model')).toHaveValue('0'))
    await waitFor(() => expect(screen.getByTestId('wework-agent-skill-8')).toBeChecked())
    expect(screen.getByTestId('wework-agent-skill-7')).not.toBeChecked()

    fireEvent.change(screen.getByTestId('wework-agent-display-name'), {
      target: { value: 'Reviewer' },
    })
    fireEvent.change(screen.getByTestId('wework-agent-system-prompt'), {
      target: { value: 'Review and summarize.' },
    })
    fireEvent.click(screen.getByTestId('wework-agent-resource-create'))

    await waitFor(() =>
      expect(updateAgent).toHaveBeenCalledWith(
        { teamId: 52, botId: 71 },
        expect.objectContaining({
          name: 'review-agent',
          displayName: 'Reviewer',
          namespace: 'workspace-alpha',
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

  it('reuses the project Agent editor and persists selected plugins for a local Agent', async () => {
    const onCreated = vi.fn(async () => undefined)
    const create = vi.fn(async () => ({ id: 'local-agent-1' }))
    const localAgentApi = {
      list: vi.fn(async () => []),
      create,
      update: vi.fn(),
      archive: vi.fn(),
    }
    const modelApi = {
      listModels: vi.fn(async () => ({ data: [] })),
    }
    const plugin = {
      id: 'review-tools@personal',
      pluginName: 'review-tools',
      marketplaceId: 'personal',
      displayName: 'Review Tools',
    }
    const pluginApi = {
      listPlugins: vi.fn(async () => [plugin]),
    }
    const host = createWeworkProjectAgentConfigurationHost(
      undefined,
      localAgentApi as never,
      modelApi as never,
      pluginApi
    )

    render(
      host.renderLocalAgentCreator!({
        onClose: vi.fn(),
        onCreated,
      })
    )

    await waitFor(() => expect(screen.getByText('Review Tools')).toBeInTheDocument())
    expect(pluginApi.listPlugins).toHaveBeenCalledWith('local-device')
    const runtime = screen.getByTestId('cloud-project-chat-agent-environment')
    expect(runtime).toHaveTextContent('Codex')
    expect(runtime.tagName).toBe('SPAN')
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-chat-agent-mode')).not.toBeInTheDocument()
    expect(screen.queryByText('仅展示当前在线的设备')).not.toBeInTheDocument()
    expect(screen.queryByText('我的本地')).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('cloud-project-chat-agent-name'), {
      target: { value: '本地评审智能体' },
    })
    fireEvent.click(screen.getByTestId(`cloud-project-chat-agent-plugin-${plugin.id}`))
    fireEvent.click(screen.getByTestId('cloud-project-chat-agent-save'))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        DEFAULT_WORK_ITEM_PROJECT_ID,
        expect.objectContaining({
          name: '本地评审智能体',
          runtime: 'codex',
          executionMode: 'auto',
          executionEnvironment: 'local',
          executionDeviceId: null,
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
      runtime: 'codex',
      model: null,
      capabilityDescription: '',
      systemPrompt: '',
      plugins: [],
      executionMode: 'manual_approval',
      maxConcurrentExecutions: 1,
      visibility: 'creator_admin',
      version: 3,
    }
    const update = vi.fn(async () => agent)
    const host = createWeworkProjectAgentConfigurationHost(
      undefined,
      { list: vi.fn(async () => [agent]), create: vi.fn(), update, archive: vi.fn() } as never,
      { listModels: vi.fn(async () => ({ data: [] })) } as never
    )
    const onSaved = vi.fn(async () => undefined)
    render(host.renderLocalAgentEditor!({ resourceId: agent.id, onClose: vi.fn(), onSaved }))
    await waitFor(() =>
      expect(screen.getByTestId('cloud-project-chat-agent-name')).toHaveValue(agent.name)
    )
    expect(screen.queryByTestId('cloud-project-chat-agent-mode')).not.toBeInTheDocument()
    expect(screen.queryByText('手动批准')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('cloud-project-chat-agent-save'))
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        DEFAULT_WORK_ITEM_PROJECT_ID,
        agent.id,
        expect.objectContaining({ version: 3, executionMode: 'auto' })
      )
    )
    expect(onSaved).toHaveBeenCalledOnce()
  })
})
