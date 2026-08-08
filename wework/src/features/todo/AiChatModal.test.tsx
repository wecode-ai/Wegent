import '@/i18n'

import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { CloudProject } from '@/api/deliveries'
import type { ProjectWithTasks, RuntimeTaskAddress } from '@/types/api'
import { AiChatModal } from './AiChatModal'

const mocks = vi.hoisted(() => ({
  chatPanelMounts: 0,
  lastOnAddressChange: null as null | ((address: RuntimeTaskAddress | null) => void),
}))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbenchPaneContext: () => ({
    createProjectRuntimeTask: vi.fn(async () => false),
  }),
}))

vi.mock('@/components/layout/workspace-panels/TemporaryChatPanel', () => ({
  TemporaryChatPanel: ({
    currentProject,
    initialAddress,
    onAddressChange,
  }: {
    currentProject: ProjectWithTasks | null
    initialAddress?: RuntimeTaskAddress | null
    onAddressChange?: (address: RuntimeTaskAddress | null) => void
  }) => {
    const mountId = useRef(++mocks.chatPanelMounts).current
    mocks.lastOnAddressChange = onAddressChange ?? null
    return (
      <div
        data-testid="mock-chat-panel"
        data-project-id={currentProject?.id ?? ''}
        data-mount-id={mountId}
        data-has-initial-address={initialAddress ? 'yes' : 'no'}
      />
    )
  },
}))

const project = {
  id: 11,
  public_id: 'cloud-public-id',
  project_key: 'WEG',
  name: 'Wegent V4',
  description: 'Shared project',
  project_store: 'backend' as const,
  task_provider: 'local' as const,
  provider_config: {},
  created_by_user_id: 1,
  status: 'active',
  version: 1,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
} as CloudProject

const localProjects: ProjectWithTasks[] = [
  { id: 91, name: '运营工作区', tasks: [] },
  { id: 92, name: '研发工作区', tasks: [] },
]

const task = {
  id: 'WEG-1',
  cloud_project_id: 11,
  sequence_number: 1,
  parent_id: null,
  created_by_user_id: 1,
  assignee_user_id: null,
  title: 'Implement cloud MCP',
  description: 'Use the shared workspace',
  status: 'in_progress' as const,
  priority: 'high' as const,
  due_at: null,
  sort_order: 0,
  current_delivery_id: null,
  version: 1,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
  completed_at: null,
}

describe('AiChatModal', () => {
  it('defaults the runtime project to the one matching the chat project', async () => {
    render(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        open
        onClose={vi.fn()}
      />
    )

    expect(screen.getByTestId('ai-chat-modal')).toHaveTextContent('私信 AI')
    expect(screen.getByTestId('ai-chat-modal')).toHaveTextContent('WEG-1 · Implement cloud MCP')
    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute('data-project-id', '91')
  })

  it('lets the user switch the runtime project', async () => {
    render(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        open
        onClose={vi.fn()}
      />
    )

    await userEvent.selectOptions(screen.getByTestId('ai-chat-runtime-project'), '92')

    expect(screen.getByTestId('mock-chat-panel')).toHaveAttribute('data-project-id', '92')
  })

  it('starts a new temporary conversation and can switch back', async () => {
    const storageKey = 'wework-ai-chat:11:WEG-1'
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({ deviceId: 'local-device', taskId: 'old-task', workspacePath: '/tmp' })
    )

    render(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        open
        onClose={vi.fn()}
      />
    )

    const panel = () => screen.getByTestId('mock-chat-panel')
    expect(panel()).toHaveAttribute('data-has-initial-address', 'yes')
    const firstMount = Number(panel().getAttribute('data-mount-id'))

    await userEvent.click(screen.getByTestId('ai-chat-new-conversation'))
    expect(panel()).toHaveAttribute('data-has-initial-address', 'no')
    expect(Number(panel().getAttribute('data-mount-id'))).toBeGreaterThan(firstMount)

    await userEvent.click(screen.getByTestId('ai-chat-new-conversation'))
    expect(panel()).toHaveAttribute('data-has-initial-address', 'yes')

    window.localStorage.removeItem(storageKey)
  })

  it('does not jump back to the saved conversation after creating a new one', async () => {
    const storageKey = 'wework-ai-chat:11:WEG-1'
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({ deviceId: 'local-device', taskId: 'old-task', workspacePath: '/tmp' })
    )

    render(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        open
        onClose={vi.fn()}
      />
    )

    const panel = () => screen.getByTestId('mock-chat-panel')
    await userEvent.click(screen.getByTestId('ai-chat-new-conversation'))
    const freshMount = Number(panel().getAttribute('data-mount-id'))

    act(() => {
      mocks.lastOnAddressChange?.({
        deviceId: 'local-device',
        taskId: 'new-task',
        workspacePath: '/tmp',
      })
    })

    // Creating the new runtime task must keep the fresh panel; remounting would
    // jump back to the old conversation.
    expect(Number(panel().getAttribute('data-mount-id'))).toBe(freshMount)
    window.localStorage.removeItem(storageKey)
  })

  it('keeps the conversation mounted while hidden so a running chat survives reopen', () => {
    const { rerender } = render(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        open
        onClose={vi.fn()}
      />
    )
    const panel = () => screen.getByTestId('mock-chat-panel')
    const firstMount = Number(panel().getAttribute('data-mount-id'))

    rerender(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        open={false}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByTestId('ai-chat-modal-backdrop')).toHaveClass('hidden')
    expect(Number(panel().getAttribute('data-mount-id'))).toBe(firstMount)

    rerender(
      <AiChatModal
        project={project}
        localProjects={localProjects}
        task={task}
        open
        onClose={vi.fn()}
      />
    )
    expect(screen.getByTestId('ai-chat-modal-backdrop')).not.toHaveClass('hidden')
    expect(Number(panel().getAttribute('data-mount-id'))).toBe(firstMount)
  })
})
