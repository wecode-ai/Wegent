import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { ProjectChatClient, ProjectChatMessage } from '@/api/backend/projectChatSocket'
import { TaskActivityView } from './TaskActivityView'
import type { Attachment } from '@/types/api'

const createProjectRuntimeTask = vi.fn()
const sendRuntimePaneMessage = vi.fn()
const openRuntimeTask = vi.fn()
const cancelRuntimeTask = vi.fn()
const bindTask = vi.fn()
const updateLoopItem = vi.fn()
const getLoopItem = vi.fn()
const listModels = vi.fn()
const attachmentSelectionMock = {
  attachments: [] as Attachment[],
  uploadingFiles: new Map(),
  errors: new Map(),
  isAttachmentReadyToSend: true,
  handleFileSelect: vi.fn(),
  addExistingAttachment: vi.fn(),
  removeAttachment: vi.fn(),
  resetAttachments: vi.fn(),
}

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbenchPaneContext: () => ({
    state: {
      runtimeWork: null,
      devices: [],
    },
    services: {
      deliveryApi: { bindTask, updateLoopItem, getLoopItem },
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
      modelApi: { listModels },
    },
    createProjectRuntimeTask,
    sendRuntimePaneMessage,
    openRuntimeTask,
    cancelRuntimeTask,
  }),
}))

vi.mock('@/components/layout/useWorkbenchPaneSession', () => ({
  useWorkbenchPaneSession: () => ({
    messages: [],
    queuedMessages: [],
    queuedMessagesPaused: false,
    guidanceMessages: [],
    codeCommentContexts: [],
    input: '',
    setInput: vi.fn(),
    error: null,
    status: {
      taskExecution: { running: false, status: 'completed' },
    },
    sending: false,
    waitingForAssistant: false,
    answeredRequestUserInputIds: new Set(),
    transcriptLoading: false,
    transcriptHasMoreBefore: false,
    transcriptLoadingMoreBefore: false,
    transcriptLoadingFullContent: false,
    transcriptFullContent: false,
    loadedTranscriptRanges: [],
    turnNavigation: [],
    subagentStatuses: [],
    goal: null,
    goalContinuing: false,
    taskPlan: null,
    goalDraftActive: false,
    loadMoreTranscriptBefore: vi.fn(),
    loadFullTranscript: vi.fn(),
    loadFullTranscriptForExport: vi.fn(),
    loadTranscriptTurnNavigationItem: vi.fn(),
    loadTranscriptGap: vi.fn(),
    send: vi.fn(),
    retryFailedMessage: vi.fn(),
    editLastUserMessage: vi.fn(),
    sendRequestUserInputResponse: vi.fn(),
    ignoreRequestUserInput: vi.fn(),
    addCodeComment: vi.fn(),
    clearCodeComments: vi.fn(),
    cancelQueuedMessage: vi.fn(),
    resumeQueuedMessages: vi.fn(),
    resumeQueuedMessagesWithInput: vi.fn(),
    clearQueuedMessages: vi.fn(),
    reorderQueuedMessages: vi.fn(),
    sendQueuedAsGuidance: vi.fn(),
    interruptAndSendQueued: vi.fn(),
    editQueuedMessage: vi.fn(),
    cancelGuidanceMessage: vi.fn(),
    pauseCurrentResponse: vi.fn(),
    compactContext: vi.fn(),
    setCurrentGoal: vi.fn(),
    cancelGoalDraft: vi.fn(),
    editCurrentGoal: vi.fn(),
    pauseCurrentGoal: vi.fn(),
    resumeCurrentGoal: vi.fn(),
    clearCurrentGoal: vi.fn(),
  }),
}))

vi.mock('@/components/chat/ScrollableMessageArea', () => ({
  ScrollableMessageArea: () => <div data-testid="runtime-execution-transcript">transcript</div>,
}))

vi.mock('@/features/workbench/useWorkbenchAttachments', () => ({
  useWorkbenchAttachments: () => attachmentSelectionMock,
}))

const userMessage: ProjectChatMessage = {
  sequenceNumber: 1,
  messageId: 'message-1',
  projectId: '11',
  taskId: 'WEG-1',
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

describe('TaskActivityView', () => {
  beforeEach(() => {
    createProjectRuntimeTask.mockReset()
    sendRuntimePaneMessage.mockReset()
    sendRuntimePaneMessage.mockResolvedValue(true)
    openRuntimeTask.mockReset()
    cancelRuntimeTask.mockReset()
    bindTask.mockReset()
    updateLoopItem.mockReset()
    getLoopItem.mockReset()
    listModels.mockReset()
    attachmentSelectionMock.attachments = []
    attachmentSelectionMock.isAttachmentReadyToSend = true
    attachmentSelectionMock.resetAttachments.mockReset()
    attachmentSelectionMock.handleFileSelect.mockReset()
    listModels.mockResolvedValue({ data: [] })
    updateLoopItem.mockImplementation(async (_id, values) => ({
      id: 'WEG-1',
      title: 'Inspect changes',
      description: 'Review the current diff',
      assignee_agent_id: '12',
      version: 2,
      ...values,
    }))
    getLoopItem.mockImplementation(async id => ({
      id,
      title: 'Inspect changes',
      description: 'Review the current diff',
      assignee_agent_id: '12',
      status: 'in_review',
      version: 8,
      ai_state: { status: 'completed', project_chat_message_id: 'message-2' },
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts the assigned AI when a task comment is added without an @ mention', async () => {
    const user = userEvent.setup()
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
      const address = {
        deviceId: 'device-1',
        taskId: 'runtime-task-1',
      }
      await options.onRuntimeTaskOptimisticOpen(address)
      return address
    })

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={
          {
            id: '11',
            name: 'Wework',
          } as never
        }
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
      />
    )

    expect(screen.getByTestId('cloud-task-activity-WEG-1')).toHaveTextContent('评论 / 动态')
    expect(screen.queryByTestId('cloud-task-activity-close')).not.toBeInTheDocument()
    await user.type(screen.getByTestId('cloud-task-activity-composer'), '继续处理')
    await user.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(client.send).toHaveBeenCalledOnce())
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '继续处理',
        mentions: [expect.objectContaining({ type: 'agent', id: '12' })],
      })
    )
    expect(createProjectRuntimeTask).toHaveBeenCalledWith(
      '继续处理',
      expect.objectContaining({
        cloudProjectId: '11',
        additionalContext: expect.objectContaining({
          projectChatTask: expect.objectContaining({
            value: expect.stringContaining('WEG-1'),
          }),
        }),
      })
    )
    expect(createProjectRuntimeTask.mock.calls[0][1].additionalContext).not.toHaveProperty(
      'projectChatHistory'
    )
    expect(createProjectRuntimeTask.mock.calls[0][1]).not.toHaveProperty('modelId')
    expect(createProjectRuntimeTask.mock.calls[0][1]).not.toHaveProperty('executionModel')
    await waitFor(() => expect(client.startAgentResponse).toHaveBeenCalledOnce())
    expect(client.startAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerMessageId: 'message-1',
        agentId: '12',
        runtimeDeviceId: 'device-1',
        runtimeTaskId: 'runtime-task-1',
      })
    )
    expect(await screen.findByText('AI 已接收')).toBeInTheDocument()
  })

  it('passes the per-comment model override to the AI run', async () => {
    listModels.mockResolvedValue({
      data: [
        {
          name: 'gpt-5.5-codex',
          type: 'runtime',
          displayName: 'GPT 5.5 Codex',
          config: { ui: { family: 'codex-official' } },
        },
      ],
    })
    const user = userEvent.setup()
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
      const address = {
        deviceId: 'device-1',
        taskId: 'runtime-task-1',
      }
      await options.onRuntimeTaskOptimisticOpen(address)
      return address
    })

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
      />
    )

    await user.click(await screen.findByTestId('model-selector-button'))
    await user.hover(await screen.findByTestId('model-control-menu-model'))
    await user.click(await screen.findByTestId('model-option-gpt-5.5-codex'))
    await user.type(screen.getByTestId('cloud-task-activity-composer'), '继续处理')
    await user.click(screen.getByRole('button', { name: '发送消息' }))

    await waitFor(() =>
      expect(client.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: '继续处理', model: 'gpt-5.5-codex' })
      )
    )
    await waitFor(() =>
      expect(createProjectRuntimeTask).toHaveBeenCalledWith(
        '继续处理',
        expect.objectContaining({
          executionModel: {
            modelId: 'gpt-5.5-codex',
            modelType: 'runtime',
            modelOptions: expect.objectContaining({ collaborationMode: 'default' }),
          },
          modelSelection: {
            modelName: 'gpt-5.5-codex',
            modelType: 'runtime',
            options: expect.any(Object),
          },
        })
      )
    )
    await waitFor(() =>
      expect(client.startAgentResponse).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.5-codex' })
      )
    )
  })

  it('shows the newest parent comment first without scrolling to the bottom', async () => {
    const older = {
      ...userMessage,
      sequenceNumber: 1,
      messageId: 'message-1',
      content: '较早评论',
    }
    const newer = {
      ...userMessage,
      sequenceNumber: 2,
      messageId: 'message-2',
      content: '最新评论',
    }
    const client = {
      subscribe: vi.fn(async () => {
        return {
          snapshot: { messages: [older, newer], latestSequence: 2, currentUserId: '1' },
          unsubscribe: vi.fn(),
        }
      }),
      send: vi.fn(async () => newer),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => agentMessage),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    const list = await screen.findByTestId('cloud-task-activity-list')
    Object.defineProperty(list, 'scrollHeight', { value: 1200, configurable: true })
    Object.defineProperty(list, 'clientHeight', { value: 400, configurable: true })
    // The scroll position lags the just-grown content (old bottom), so a
    // naive "am I still at the bottom?" check would wrongly disable follow.
    Object.defineProperty(list, 'scrollTop', { value: 500, configurable: true })
    const scrollTo = vi.fn()
    Object.defineProperty(list, 'scrollTo', { value: scrollTo, configurable: true })
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      overflowY: 'auto',
      getPropertyValue: () => '',
    } as unknown as CSSStyleDeclaration)

    await screen.findByText('最新评论')
    const cards = list.querySelectorAll('.task-detail-comment-card')
    expect(cards).toHaveLength(2)
    expect(cards[0]).toHaveTextContent('最新评论')
    expect(cards[1]).toHaveTextContent('较早评论')

    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('scrolls the comment list to the top when a new parent comment is sent', async () => {
    const user = userEvent.setup()
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [], latestSequence: 0, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => agentMessage),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    const list = await screen.findByTestId('cloud-task-activity-list')
    Object.defineProperty(list, 'scrollHeight', { value: 1200, configurable: true })
    Object.defineProperty(list, 'clientHeight', { value: 400, configurable: true })
    Object.defineProperty(list, 'scrollTop', { value: 500, configurable: true })
    const scrollTo = vi.fn()
    Object.defineProperty(list, 'scrollTo', { value: scrollTo, configurable: true })
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      overflowY: 'auto',
      getPropertyValue: () => '',
    } as unknown as CSSStyleDeclaration)

    await user.type(screen.getByTestId('cloud-task-activity-composer'), '新评论')
    await user.click(screen.getByRole('button', { name: '发送消息' }))

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' }))
    expect(scrollTo).not.toHaveBeenCalledWith({ top: 1200, behavior: 'auto' })
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
      <TaskActivityView
        client={client}
        currentUserId={999}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_progress',
            version: 1,
          } as never
        }
      />
    )

    expect(await screen.findByTestId('cloud-task-activity-message-message-1')).toHaveAttribute(
      'data-side',
      'right'
    )
    expect(screen.getByTestId('cloud-task-activity-message-message-2')).toHaveAttribute(
      'data-side',
      'left'
    )
  })

  it('syncs completed AI activity to local review state without re-saving the task', async () => {
    const completedAgentMessage = {
      ...agentMessage,
      type: 'text' as const,
      content: 'Ready for review',
      metadata: { run_id: 'run-123456789', run_status: 'completed' },
      status: 'completed' as const,
    }
    const onTaskUpdated = vi.fn()
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [completedAgentMessage], latestSequence: 2, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => completedAgentMessage),
      failAgentResponse: vi.fn(async () => ({
        ...completedAgentMessage,
        status: 'failed' as const,
      })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_progress',
            version: 7,
            assignee_agent_id: '12',
          } as never
        }
        onTaskUpdated={onTaskUpdated}
        linear
      />
    )

    expect(await screen.findByText('已完成')).toBeInTheDocument()
    expect(screen.queryByText('已提交结果，等待验收')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(onTaskUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'in_review', version: 8 })
      )
    )
    expect(updateLoopItem).not.toHaveBeenCalled()
  })

  it('shows completed when message status is terminal but run metadata is stale', async () => {
    const completedAgentMessage = {
      ...agentMessage,
      type: 'text' as const,
      content: '任务已执行完成。',
      metadata: { run_id: 'run-81610026', run_status: 'running' },
      status: 'completed' as const,
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [completedAgentMessage], latestSequence: 2, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => completedAgentMessage),
      failAgentResponse: vi.fn(async () => ({
        ...completedAgentMessage,
        status: 'failed' as const,
      })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_progress',
            version: 7,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    const card = await screen.findByTestId('cloud-task-activity-message-message-2')
    expect(card).toHaveTextContent('任务已执行完成。')
    expect(card).toHaveTextContent('已完成')
    expect(card).not.toHaveTextContent('正在处理')
  })

  it('offers human review actions after AI submits a task result', async () => {
    const user = userEvent.setup()
    const completedAgentMessage = {
      ...agentMessage,
      type: 'text' as const,
      content: 'Ready for review',
      metadata: { run_id: 'run-123456789', run_status: 'completed' },
      status: 'completed' as const,
    }
    const onTaskUpdated = vi.fn()
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [completedAgentMessage], latestSequence: 2, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => ({ ...agentMessage, messageId: 'message-3' })),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient
    createProjectRuntimeTask.mockImplementation(async (_prompt, options) => {
      const address = {
        deviceId: 'device-1',
        taskId: 'runtime-task-rerun',
      }
      await options.onRuntimeTaskOptimisticOpen(address)
      return address
    })

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_review',
            version: 7,
            assignee_agent_id: '12',
          } as never
        }
        onTaskUpdated={onTaskUpdated}
        linear
      />
    )

    expect(await screen.findByTestId('cloud-task-activity-review-actions-WEG-1')).toHaveTextContent(
      '继续修改'
    )
    await user.click(screen.getByTestId('cloud-task-activity-continue-WEG-1'))
    expect(screen.getByTestId('cloud-task-activity-composer')).toHaveFocus()

    await user.click(screen.getByTestId('cloud-task-activity-rerun-WEG-1'))
    await waitFor(() =>
      expect(client.startAgentResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          triggerMessageId: undefined,
          runtimeTaskId: 'runtime-task-rerun',
          prompt: expect.stringContaining('请开始执行任务 WEG-1：Inspect changes'),
        })
      )
    )

    await user.click(screen.getByTestId('cloud-task-activity-accept-WEG-1'))
    await waitFor(() =>
      expect(updateLoopItem).toHaveBeenCalledWith('WEG-1', {
        version: 7,
        status: 'completed',
      })
    )
    expect(onTaskUpdated).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
  })

  it('offers manual rerun when the assigned AI run failed', async () => {
    listModels.mockResolvedValue({
      data: [
        {
          name: 'gpt-5.5-codex',
          type: 'runtime',
          displayName: 'GPT 5.5 Codex',
          config: { ui: { family: 'codex-official' } },
        },
      ],
    })
    const user = userEvent.setup()
    const requestedModelMessage = {
      ...userMessage,
      sequenceNumber: 1,
      messageId: 'message-1',
      content: '用大模型继续',
      metadata: { model: 'gpt-5.5-codex' },
    }
    const failedAgentMessage = {
      ...agentMessage,
      type: 'text' as const,
      content: 'runtime failed',
      metadata: { run_id: 'run-failed-1', run_status: 'failed' },
      status: 'failed' as const,
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: {
          messages: [requestedModelMessage, failedAgentMessage],
          latestSequence: 2,
          currentUserId: '1',
        },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => ({ ...agentMessage, messageId: 'message-3' })),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient
    createProjectRuntimeTask.mockImplementation(async (_prompt, options) => {
      const address = {
        deviceId: 'device-1',
        taskId: 'runtime-task-rerun-failed',
      }
      await options.onRuntimeTaskOptimisticOpen(address)
      return address
    })

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_progress',
            version: 7,
            assignee_agent_id: '12',
            ai_state: {
              status: 'failed',
              project_chat_message_id: 'message-2',
              last_error: 'runtime failed',
            },
          } as never
        }
        linear
      />
    )

    const rerun = await screen.findByTestId('cloud-task-activity-rerun-WEG-1')
    expect(rerun).toHaveTextContent('重新执行')
    await user.click(rerun)
    await waitFor(() =>
      expect(client.startAgentResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          triggerMessageId: undefined,
          runtimeTaskId: 'runtime-task-rerun-failed',
          prompt: expect.stringContaining('请开始执行任务 WEG-1：Inspect changes'),
          model: 'gpt-5.5-codex',
        })
      )
    )
    expect(createProjectRuntimeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        executionModel: expect.objectContaining({ modelId: 'gpt-5.5-codex' }),
      })
    )
  })

  it('renders child-agent activity as a single nested AI message', async () => {
    const subagentMessage = {
      ...agentMessage,
      sequenceNumber: 3,
      messageId: 'message-subagent',
      sender: { type: 'agent' as const, id: '12:tests', name: 'Code Reviewer.测试' },
      type: 'text' as const,
      content: '测试通过',
      metadata: { kind: 'task_ai_subagent', subagent_name: '测试' },
      status: 'completed' as const,
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [subagentMessage], latestSequence: 3, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_progress',
            version: 7,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    const message = await screen.findByTestId('cloud-task-activity-message-message-subagent')
    expect(message).toHaveTextContent('Code Reviewer.测试')
    expect(message).toHaveTextContent('子任务执行')
    expect(message).toHaveTextContent('测试通过')
    expect(message).not.toHaveTextContent('已提交结果，等待验收')
  })

  it('opens AI execution details in a floating panel without navigating away', async () => {
    const user = userEvent.setup()
    const completedAgentMessage: ProjectChatMessage = {
      ...agentMessage,
      type: 'text',
      content: 'Ready for review',
      metadata: { run_id: 'run-123', model: 'gpt-5.2-codex' },
      status: 'completed',
      runtimeAddress: { deviceId: 'device-1', taskId: 'runtime-task-1' },
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [completedAgentMessage], latestSequence: 2, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_progress',
            version: 7,
            assignee_agent_id: '12',
          } as never
        }
      />
    )

    await user.click(await screen.findByTestId('cloud-task-activity-open-execution-message-2'))

    expect(await screen.findByTestId('runtime-execution-detail-overlay')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-execution-transcript')).toBeInTheDocument()
    expect(screen.getByText('在任务页打开')).toBeInTheDocument()
    expect(openRuntimeTask).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('runtime-execution-detail-close'))
    expect(screen.queryByTestId('runtime-execution-detail-overlay')).not.toBeInTheDocument()
  })

  it('shows the stop action for a running AI run inside the floating panel', async () => {
    const user = userEvent.setup()
    const runningAgentMessage: ProjectChatMessage = {
      ...agentMessage,
      type: 'agent_chunk',
      content: 'working…',
      metadata: { run_id: 'run-456' },
      status: 'streaming',
      runtimeAddress: { deviceId: 'device-1', taskId: 'runtime-task-2' },
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [runningAgentMessage], latestSequence: 2, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_progress',
            version: 7,
            assignee_agent_id: '12',
          } as never
        }
      />
    )

    await user.click(await screen.findByTestId('cloud-task-activity-open-execution-message-2'))

    const stopButton = await screen.findByTestId('runtime-execution-detail-stop')
    expect(stopButton).toBeInTheDocument()
    await user.click(stopButton)
    await waitFor(() =>
      expect(cancelRuntimeTask).toHaveBeenCalledWith({
        deviceId: 'device-1',
        taskId: 'runtime-task-2',
      })
    )
  })

  function sendButtonFor(composerTestId: string) {
    const composer = screen.getByTestId(composerTestId)
    const form = composer.closest('form')
    return within(form as HTMLElement).getByRole('button', { name: '发送消息' })
  }

  it('continues the card AI session from the inline composer', async () => {
    const user = userEvent.setup()
    const rootMessage: ProjectChatMessage = {
      ...userMessage,
      rootMessageId: null,
    }
    const completedAgentMessage: ProjectChatMessage = {
      ...agentMessage,
      content: '已检查当前改动，发现 2 处问题。',
      status: 'completed',
      runtimeAddress: { deviceId: 'device-1', taskId: 'parent-session-1' },
      rootMessageId: userMessage.messageId,
      replyToMessageId: userMessage.messageId,
    }
    const attachment: Attachment = {
      id: 7,
      filename: 'spec.txt',
      file_size: 12,
      mime_type: 'text/plain',
      status: 'ready',
      file_extension: 'txt',
      created_at: '2026-08-06T00:00:00Z',
    }
    attachmentSelectionMock.attachments = [attachment]
    sendRuntimePaneMessage.mockResolvedValue(true)
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: {
          messages: [rootMessage, completedAgentMessage],
          latestSequence: 2,
          currentUserId: '1',
        },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    expect(
      screen.queryByTestId(`cloud-task-activity-reply-${completedAgentMessage.messageId}`)
    ).not.toBeInTheDocument()
    await user.type(
      await screen.findByTestId(`cloud-task-activity-card-composer-${rootMessage.messageId}`),
      '继续处理{Enter}'
    )

    await waitFor(() => expect(client.send).toHaveBeenCalledOnce())
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: rootMessage.messageId,
      })
    )
    await waitFor(() =>
      expect(sendRuntimePaneMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          address: { deviceId: 'device-1', taskId: 'parent-session-1' },
          message: '继续处理',
          attachmentIds: [7],
        }),
        expect.anything()
      )
    )
    expect(createProjectRuntimeTask).not.toHaveBeenCalled()
  })

  it('replies to the parent comment from the card composer by default', async () => {
    const user = userEvent.setup()
    const rootMessage: ProjectChatMessage = {
      ...userMessage,
      rootMessageId: null,
    }
    const completedAgentMessage: ProjectChatMessage = {
      ...agentMessage,
      content: '已检查当前改动。',
      status: 'completed',
      runtimeAddress: { deviceId: 'device-1', taskId: 'parent-session-1' },
      rootMessageId: userMessage.messageId,
      replyToMessageId: userMessage.messageId,
    }
    sendRuntimePaneMessage.mockResolvedValue(true)
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: {
          messages: [rootMessage, completedAgentMessage],
          latestSequence: 2,
          currentUserId: '1',
        },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    await user.type(
      await screen.findByTestId(`cloud-task-activity-card-composer-${rootMessage.messageId}`),
      '直接回复父评论{Enter}'
    )

    await waitFor(() => expect(client.send).toHaveBeenCalledOnce())
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: rootMessage.messageId,
      })
    )
    expect(
      screen.queryByTestId(`cloud-task-activity-reply-chip-${rootMessage.messageId}`)
    ).not.toBeInTheDocument()
  })

  it('shows a send button on the card composer only after typing', async () => {
    const user = userEvent.setup()
    const rootMessage: ProjectChatMessage = {
      ...userMessage,
      rootMessageId: null,
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [rootMessage], latestSequence: 1, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    const composer = await screen.findByTestId(
      `cloud-task-activity-card-composer-${rootMessage.messageId}`
    )
    // Keep the AI start pending so the test proves the draft clears right
    // after the comment is sent, without waiting for the runtime task.
    createProjectRuntimeTask.mockReturnValue(new Promise(() => {}))
    expect(
      screen.queryByTestId(`cloud-task-activity-card-send-${rootMessage.messageId}`)
    ).not.toBeInTheDocument()

    await user.type(composer, '继续处理')
    expect(
      screen.getByTestId(`cloud-task-activity-card-send-${rootMessage.messageId}`)
    ).toBeInTheDocument()

    await user.click(screen.getByTestId(`cloud-task-activity-card-send-${rootMessage.messageId}`))
    await waitFor(() => expect(client.send).toHaveBeenCalledOnce())
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '继续处理',
        replyToMessageId: rootMessage.messageId,
      })
    )
    await waitFor(() => expect(composer).toHaveValue(''))
  })

  it('passes comment attachments to the AI run', async () => {
    const user = userEvent.setup()
    const attachment: Attachment = {
      id: 7,
      filename: 'spec.txt',
      file_size: 12,
      mime_type: 'text/plain',
      status: 'ready',
      file_extension: 'txt',
      created_at: '2026-08-06T00:00:00Z',
    }
    attachmentSelectionMock.attachments = [attachment]
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

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    await user.type(await screen.findByTestId('cloud-task-activity-composer'), '看下附件')
    await user.click(screen.getByRole('button', { name: '发送消息' }))

    await waitFor(() => expect(client.send).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(createProjectRuntimeTask).toHaveBeenCalledWith(
        '看下附件',
        expect.objectContaining({ attachments: [attachment] })
      )
    )
    expect(attachmentSelectionMock.resetAttachments).toHaveBeenCalledOnce()
  })

  it('passes attachments from the card composer to the AI run', async () => {
    const user = userEvent.setup()
    const rootMessage: ProjectChatMessage = {
      ...userMessage,
      rootMessageId: null,
    }
    const attachment: Attachment = {
      id: 8,
      filename: 'notes.txt',
      file_size: 24,
      mime_type: 'text/plain',
      status: 'ready',
      file_extension: 'txt',
      created_at: '2026-08-06T00:00:00Z',
    }
    attachmentSelectionMock.attachments = [attachment]
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [rootMessage], latestSequence: 1, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    const composer = await screen.findByTestId(
      `cloud-task-activity-card-composer-${rootMessage.messageId}`
    )
    expect(
      screen.getByTestId(`cloud-task-activity-card-attach-${rootMessage.messageId}`)
    ).toBeInTheDocument()
    expect(
      screen.getByTestId(`cloud-task-activity-card-attachment-${rootMessage.messageId}-8`)
    ).toHaveTextContent('notes.txt')

    await user.type(composer, '看下附件')
    await user.click(screen.getByTestId(`cloud-task-activity-card-send-${rootMessage.messageId}`))

    await waitFor(() => expect(client.send).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(createProjectRuntimeTask).toHaveBeenCalledWith(
        '看下附件',
        expect.objectContaining({ attachments: [attachment] })
      )
    )
    await waitFor(() => expect(composer).toHaveValue(''))
  })

  it('uploads files pasted into the card composer', async () => {
    const rootMessage: ProjectChatMessage = {
      ...userMessage,
      rootMessageId: null,
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [rootMessage], latestSequence: 1, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    const composer = await screen.findByTestId(
      `cloud-task-activity-card-composer-${rootMessage.messageId}`
    )
    const file = new File(['clipboard-image'], 'clip.png', { type: 'image/png' })
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { files: [file] },
    })

    fireEvent(composer, pasteEvent)

    expect(attachmentSelectionMock.handleFileSelect).toHaveBeenCalledWith([file])
  })

  it('uploads files selected through the card composer attach button', async () => {
    const rootMessage: ProjectChatMessage = {
      ...userMessage,
      rootMessageId: null,
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: { messages: [rootMessage], latestSequence: 1, currentUserId: '1' },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    await screen.findByTestId(`cloud-task-activity-card-composer-${rootMessage.messageId}`)
    const fileInput = screen.getByTestId(`cloud-task-activity-card-file-${rootMessage.messageId}`)
    const file = new File(['report-content'], 'report.pdf', { type: 'application/pdf' })

    fireEvent.change(fileInput, { target: { files: [file] } })

    expect(attachmentSelectionMock.handleFileSelect).toHaveBeenCalledWith([file])
  })

  it('starts a fresh session for a plain new comment even when the task has a previous binding', async () => {
    const user = userEvent.setup()
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

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
            ai_state: {
              status: 'completed',
              runtime_device_id: 'device-1',
              runtime_task_id: 'old-session-1',
            },
          } as never
        }
      />
    )

    await user.type(screen.getByTestId('cloud-task-activity-composer'), '新评论')
    await user.click(sendButtonFor('cloud-task-activity-composer'))

    await waitFor(() => expect(client.send).toHaveBeenCalledOnce())
    expect(sendRuntimePaneMessage).not.toHaveBeenCalled()
    expect(createProjectRuntimeTask).toHaveBeenCalledWith(
      '新评论',
      expect.objectContaining({
        cloudProjectId: '11',
        hiddenFromSidebar: true,
        continuable: true,
      })
    )
  })

  it('blocks sending from the card composer while the card session is still running', async () => {
    const user = userEvent.setup()
    const rootMessage: ProjectChatMessage = {
      ...userMessage,
      rootMessageId: null,
    }
    const runningAgentMessage: ProjectChatMessage = {
      ...agentMessage,
      content: 'working…',
      status: 'streaming',
      runtimeAddress: { deviceId: 'device-1', taskId: 'parent-session-1' },
      rootMessageId: userMessage.messageId,
      replyToMessageId: userMessage.messageId,
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: {
          messages: [rootMessage, runningAgentMessage],
          latestSequence: 2,
          currentUserId: '1',
        },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'in_progress',
            version: 7,
            assignee_agent_id: '12',
          } as never
        }
        linear
      />
    )

    await user.type(
      await screen.findByTestId(`cloud-task-activity-card-composer-${rootMessage.messageId}`),
      '继续处理{Enter}'
    )

    expect(client.send).not.toHaveBeenCalled()
    expect(
      screen.getByTestId(`cloud-task-activity-card-error-${rootMessage.messageId}`)
    ).toHaveTextContent('当前回复仍在进行中，请稍后再发送')
  })

  it('allows a plain new comment while another parent session is still running', async () => {
    const user = userEvent.setup()
    const runningAgentMessage: ProjectChatMessage = {
      ...agentMessage,
      content: 'working…',
      status: 'streaming',
      runtimeAddress: { deviceId: 'device-1', taskId: 'parent-session-1' },
    }
    const client = {
      subscribe: vi.fn(async () => ({
        snapshot: {
          messages: [userMessage, runningAgentMessage],
          latestSequence: 2,
          currentUserId: '1',
        },
        unsubscribe: vi.fn(),
      })),
      send: vi.fn(async () => userMessage),
      startAgentResponse: vi.fn(async () => agentMessage),
      failAgentResponse: vi.fn(async () => ({ ...agentMessage, status: 'failed' as const })),
      dispose: vi.fn(),
    } satisfies ProjectChatClient

    render(
      <TaskActivityView
        client={client}
        currentUserId={1}
        project={{ id: '11', name: 'Wework' } as never}
        task={
          {
            id: 'WEG-1',
            title: 'Inspect changes',
            description: 'Review the current diff',
            status: 'inbox',
            version: 1,
            assignee_agent_id: '12',
          } as never
        }
      />
    )

    await user.type(screen.getByTestId('cloud-task-activity-composer'), '新评论')
    await user.click(screen.getByRole('button', { name: '发送消息' }))

    await waitFor(() => expect(client.send).toHaveBeenCalledOnce())
    expect(createProjectRuntimeTask).toHaveBeenCalledWith(
      '新评论',
      expect.objectContaining({ cloudProjectId: '11' })
    )
  })
})
