import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { ProjectChatClient, ProjectChatMessage } from '@/api/backend/projectChatSocket'
import { TaskActivityView } from './TaskActivityView'

const createProjectRuntimeTask = vi.fn()
const sendRuntimePaneMessage = vi.fn()
const openRuntimeTask = vi.fn()
const cancelRuntimeTask = vi.fn()
const bindTask = vi.fn()
const updateLoopItem = vi.fn()
const getLoopItem = vi.fn()
const listModels = vi.fn()

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
    openRuntimeTask.mockReset()
    cancelRuntimeTask.mockReset()
    bindTask.mockReset()
    updateLoopItem.mockReset()
    getLoopItem.mockReset()
    listModels.mockReset()
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
          projectChatHistory: expect.objectContaining({
            value: expect.stringContaining('[Ada] @Code Reviewer inspect this'),
          }),
        }),
      })
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

  it('pins the comment list to the bottom when messages arrive', async () => {
    let pushMessage: ((message: ProjectChatMessage) => void) | undefined
    const client = {
      subscribe: vi.fn(async (_projectId, _taskId, _afterSequence, onMessage) => {
        pushMessage = onMessage
        return {
          snapshot: { messages: [userMessage], latestSequence: 1, currentUserId: '1' },
          unsubscribe: vi.fn(),
        }
      }),
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
        rail
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
    } as CSSStyleDeclaration)

    pushMessage?.({
      ...agentMessage,
      sequenceNumber: 2,
      messageId: 'message-2',
      content: '流式回复',
    })

    await waitFor(() => expect(scrollTo).toHaveBeenCalled())
    expect(scrollTo).toHaveBeenCalledWith({ top: 1200, behavior: 'auto' })
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
})
