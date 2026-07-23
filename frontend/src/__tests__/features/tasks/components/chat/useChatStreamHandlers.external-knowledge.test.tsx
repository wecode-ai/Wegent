// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from '@testing-library/react'
import { useChatStreamHandlers } from '@/features/tasks/components/chat/useChatStreamHandlers'
import type { ContextItem } from '@/types/context'
import type { SubtaskContextBrief, TaskDetail } from '@/types/api'

const mockContextSendMessage = jest.fn()

const selectedTaskDetailMock = {
  id: 42,
  status: 'COMPLETED',
  is_group_chat: false,
  subtasks: [],
} as unknown as TaskDetail

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/chat',
}))

jest.mock('@/features/tasks/session/TaskSession', () => ({
  useTaskSession: () => ({
    currentTaskId: 42,
    selectedTaskDetail: selectedTaskDetailMock,
    refreshTasks: jest.fn(),
    refreshSelectedTaskDetail: jest.fn(),
    markTaskAsViewed: jest.fn(),
    sendMessage: mockContextSendMessage,
    stopStream: jest.fn(),
    recoverCurrentTask: jest.fn().mockResolvedValue(undefined),
    taskState: {
      taskId: 42,
      phase: 'ready',
      messages: new Map(),
      isStopping: false,
      runtime: { taskStatus: 'COMPLETED', activeStreamSubtaskId: undefined },
      derived: {
        isExecutionActive: false,
        isTerminal: true,
        isStreaming: false,
        shouldJoinRoom: false,
        canSendMessage: true,
        canQueueMessage: false,
        canCancelTask: false,
        blocksQueuedDispatch: false,
      },
    },
  }),
}))

jest.mock('@/features/projects/contexts/projectContext', () => ({
  useProjectContext: () => ({
    projects: [],
    projectTaskIds: new Set(),
    refreshProjects: jest.fn(),
    isWorkspaceEnabled: false,
  }),
}))

jest.mock('@wegent/chat-core', () => ({ generateMessageId: () => 'local-user-1' }))

jest.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({
    retryMessage: jest.fn(),
    sendChatGuidance: jest.fn().mockResolvedValue({ success: true }),
    registerChatHandlers: jest.fn(() => jest.fn()),
  }),
}))

jest.mock('@/contexts/DeviceContext', () => ({
  useDevices: () => ({ selectedDeviceId: null }),
}))

jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: jest.fn() }) }))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/features/common/UserContext', () => ({ useUser: () => ({ user: { id: 7 } }) }))

jest.mock('@/hooks/useTraceAction', () => ({
  useTraceAction: () => ({
    traceAction: (_name: string, _attrs: Record<string, string>, fn: () => unknown) => fn(),
  }),
}))

function renderSendHook(selectedContexts: ContextItem[]) {
  return renderHook(() =>
    useChatStreamHandlers({
      selectedTeam: { id: 5, name: 'Team', agent_type: 'chat' } as never,
      selectedModel: null,
      forceOverride: false,
      setSelectedModel: jest.fn(),
      setForceOverride: jest.fn(),
      selectedRepo: null,
      selectedBranch: null,
      showRepositorySelector: false,
      effectiveRequiresWorkspace: false,
      taskInputMessage: 'find the spec',
      setTaskInputMessage: jest.fn(),
      enableDeepThinking: false,
      enableClarification: false,
      externalApiParams: {},
      attachments: [] as never,
      resetAttachment: jest.fn(),
      isAttachmentReadyToSend: true,
      taskType: 'chat',
      shouldHideChatInput: false,
      scrollToBottom: jest.fn(),
      selectedContexts,
      resetContexts: jest.fn(),
      additionalSkills: [],
    })
  )
}

describe('useChatStreamHandlers external knowledge contexts', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('sends external_knowledge through contexts alongside internal knowledge bases', async () => {
    const externalCtx: ContextItem = {
      type: 'external_knowledge',
      id: 'external:demo:explicit:lib-1',
      name: 'Lib One',
      ref: {
        provider: 'demo',
        mode: 'explicit',
        id: 'lib-1',
        name: 'Lib One',
        scope: 'org',
      },
    }
    const kbCtx: ContextItem = {
      type: 'knowledge_base',
      id: 5,
      name: 'Product Docs',
      document_count: 3,
    } as ContextItem

    const { result } = renderSendHook([kbCtx, externalCtx])

    await act(async () => {
      await result.current.handleSendMessage()
    })

    expect(mockContextSendMessage).toHaveBeenCalledTimes(1)
    const request = mockContextSendMessage.mock.calls[0][0]

    expect(request).not.toHaveProperty('externalKnowledgeRefs')
    expect(request).not.toHaveProperty('externalKnowledgeRefsReplace')

    // The internal KB and external knowledge selection share the contexts channel.
    expect(request.contexts).toEqual([
      {
        type: 'knowledge_base',
        data: {
          knowledge_id: 5,
          name: 'Product Docs',
          document_count: 3,
          document_ids: undefined,
          scope_restricted: undefined,
        },
      },
      {
        type: 'external_knowledge',
        data: {
          external_ref: {
            provider: 'demo',
            mode: 'explicit',
            id: 'lib-1',
            name: 'Lib One',
            scope: 'org',
          },
        },
      },
    ])
  })

  it('does not send a top-level external knowledge field when no external context is selected', async () => {
    const kbCtx: ContextItem = {
      type: 'knowledge_base',
      id: 5,
      name: 'Product Docs',
      document_count: 3,
    } as ContextItem

    const { result } = renderSendHook([kbCtx])

    await act(async () => {
      await result.current.handleSendMessage()
    })

    const request = mockContextSendMessage.mock.calls[0][0]
    expect(request).not.toHaveProperty('externalKnowledgeRefs')
    expect(request).not.toHaveProperty('externalKnowledgeRefsReplace')
  })

  it('resends external knowledge as canonical external_ref during regeneration', async () => {
    const originalContexts: SubtaskContextBrief[] = [
      {
        id: 90,
        context_type: 'external_knowledge',
        name: 'Roadmap.md',
        status: 'ready',
        external_ref: {
          provider: 'dingtalk',
          mode: 'explicit',
          id: 'docs',
          name: 'DingTalk Docs',
          scope: 'personal',
          target_type: 'document',
          node_id: 'node-1',
          document_id: 'doc-1',
          target_name: 'Roadmap.md',
        },
        external_provider: 'stale-provider',
        external_mode: 'explicit',
        external_id: 'stale-id',
      },
    ]

    const { result } = renderSendHook([])

    await act(async () => {
      await result.current.handleSendMessageWithModel(
        'find the spec',
        { name: 'gpt-test', type: 'public' } as never,
        originalContexts
      )
    })

    const request = mockContextSendMessage.mock.calls[0][0]
    expect(request.contexts).toEqual([
      {
        type: 'external_knowledge',
        data: {
          external_ref: {
            provider: 'dingtalk',
            mode: 'explicit',
            id: 'docs',
            name: 'DingTalk Docs',
            scope: 'personal',
            target_type: 'document',
            node_id: 'node-1',
            document_id: 'doc-1',
            target_name: 'Roadmap.md',
          },
        },
      },
    ])
  })
})
