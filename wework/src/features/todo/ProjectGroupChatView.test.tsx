import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { ProjectChatClient, ProjectChatMessage } from '@/api/backend/projectChatSocket'
import { ProjectGroupChatView } from './ProjectGroupChatView'

const createProjectRuntimeTask = vi.fn()
const bindTask = vi.fn()

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbenchPaneContext: () => ({
    services: {
      deliveryApi: { bindTask },
      projectChatAgentApi: {
        list: vi.fn(async () => [
          {
            id: '12',
            projectId: '11',
            name: 'Code Reviewer',
            runtime: 'codex',
            model: null,
            systemPrompt: '',
            status: 'active',
            version: 1,
            createdAt: '',
            updatedAt: '',
          },
        ]),
      },
    },
    createProjectRuntimeTask,
  }),
}))

const userMessage: ProjectChatMessage = {
  sequenceNumber: 1,
  messageId: 'message-1',
  projectId: '11',
  taskId: null,
  sender: { type: 'user', id: '1', name: 'Ada' },
  type: 'text',
  content: '@Code Reviewer inspect this',
  metadata: {
    mentions: [{ type: 'agent', id: '12', label: 'Code Reviewer' }],
  },
  status: 'completed',
  createdAt: '2026-08-03T00:00:00Z',
  updatedAt: '2026-08-03T00:00:00Z',
}

const agentMessage: ProjectChatMessage = {
  ...userMessage,
  sequenceNumber: 2,
  messageId: 'message-2',
  sender: { type: 'agent', id: '12', name: 'Code Reviewer' },
  type: 'agent_chunk',
  content: '',
  metadata: {},
  status: 'streaming',
}

describe('ProjectGroupChatView', () => {
  beforeEach(() => {
    createProjectRuntimeTask.mockReset()
    bindTask.mockReset()
  })

  it('invokes a configured AI only after selecting its structured mention', async () => {
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [], latestSequence: 0, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient
    createProjectRuntimeTask.mockImplementation(async (_prompt, options) => {
      await options.onRuntimeTaskOptimisticOpen({
        deviceId: 'device-1',
        taskId: 'runtime-task-1',
      })
    })

    render(
      <ProjectGroupChatView
        client={client}
        currentUserId={1}
        project={
          {
            id: '11',
            name: 'Wework',
          } as never
        }
      />
    )

    const composer = await screen.findByTestId('cloud-project-group-chat-composer')
    await userEvent.type(composer, '@Code')
    await userEvent.click(screen.getByTestId('cloud-project-chat-mention-agent-12'))
    await userEvent.type(composer, 'inspect this')
    await userEvent.click(screen.getByTestId('cloud-project-group-chat-send'))

    await waitFor(() => expect(client.send).toHaveBeenCalledOnce())
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '@Code Reviewer inspect this',
        mentions: [expect.objectContaining({ type: 'agent', id: '12' })],
      })
    )
    expect(createProjectRuntimeTask).toHaveBeenCalledWith(
      '@Code Reviewer inspect this',
      expect.objectContaining({
        modelId: null,
        cloudProjectId: '11',
        additionalContext: expect.objectContaining({
          projectChatHistory: expect.objectContaining({
            value: expect.stringContaining('[Ada] @Code Reviewer inspect this'),
          }),
        }),
      })
    )
    await waitFor(() => expect(client.startAgentResponse).toHaveBeenCalledOnce())
    expect(client.startAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerMessageId: 'message-1',
        agentId: '12',
        runtimeDeviceId: 'device-1',
        runtimeTaskId: 'runtime-task-1',
      })
    )
    expect(screen.getByText('AI 已接收')).toBeInTheDocument()
  })

  it('places only the current user on the right when an AI has the same id', async () => {
    const collidingAgent = {
      ...agentMessage,
      sender: { type: 'agent' as const, id: '1', name: 'Local WeWork' },
    }
    const client = {
      subscribe: vi.fn(async (_projectId, _taskId, _afterSequence, onMessage) => {
        onMessage(userMessage)
        onMessage(collidingAgent)
        return {
          snapshot: {
            messages: [userMessage, collidingAgent],
            latestSequence: 2,
            currentUserId: '1',
          },
          unsubscribe: vi.fn(),
        }
      }),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => collidingAgent),
      failAgentResponse: vi.fn(async () => ({ ...collidingAgent, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <ProjectGroupChatView
        client={client}
        currentUserId={999}
        project={{ id: '11', name: 'Wework' } as never}
      />
    )

    expect(await screen.findByTestId('cloud-project-chat-message-message-1')).toHaveAttribute(
      'data-side',
      'right'
    )
    expect(screen.getByTestId('cloud-project-chat-message-message-2')).toHaveAttribute(
      'data-side',
      'left'
    )
  })
})
