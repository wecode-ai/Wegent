import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { createAgentResourceApi } from '@/api/agentResources'
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
                  disabled: true,
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
    expect(screen.getByTestId('mode-existing')).toBeDisabled()
    expect(screen.getByTestId('mode-existing-card')).toHaveClass('cursor-not-allowed', 'opacity-45')
    expect(screen.getByTestId('mode-create-card')).toHaveClass(
      'border-focus',
      'bg-focus/5',
      'ring-1'
    )
    expect(screen.getByTestId('agent-submit')).toHaveClass('rounded-lg', 'bg-text-primary')

    fireEvent.click(screen.getByTestId('mode-existing'))
    expect(onModeChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('agent-close'))
    expect(onClose).toHaveBeenCalledOnce()
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
    expect(screen.queryByText('Claude Review')).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('wework-agent-runtime'), {
      target: { value: 'ClaudeCode' },
    })
    await waitFor(() => expect(screen.getByText('Claude Review')).toBeInTheDocument())
    expect(screen.queryByText('Codex Review')).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('wework-agent-resource-name'), {
      target: { value: 'review-agent' },
    })
    fireEvent.change(screen.getByTestId('wework-agent-display-name'), {
      target: { value: 'Review Agent' },
    })
    fireEvent.change(screen.getByTestId('wework-agent-model'), {
      target: { value: '0' },
    })
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
})
