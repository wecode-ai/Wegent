// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { useChatStreamHandlers } from '@/features/tasks/components/chat/useChatStreamHandlers'
import type { ContextItem } from '@/types/context'
import type { TaskDetail, TaskType } from '@/types/api'

const mockContextSendMessage = jest.fn()
const mockToast = jest.fn()

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

jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('@/features/common/UserContext', () => ({ useUser: () => ({ user: { id: 7 } }) }))

jest.mock('@/hooks/useTraceAction', () => ({
  useTraceAction: () => ({
    traceAction: (_name: string, _attrs: Record<string, string>, fn: () => unknown) => fn(),
  }),
}))

function renderSendHook(
  selectedContexts: ContextItem[],
  options: {
    taskType?: TaskType
    knowledgeBaseId?: number
    selectedDocumentIds?: number[]
    attachments?: unknown[]
    isAttachmentReadyToSend?: boolean
    externalApiParams?: Record<string, string>
  } = {}
) {
  const setTaskInputMessage = jest.fn()
  const resetAttachment = jest.fn()
  const resetContexts = jest.fn()
  const hook = renderHook(() =>
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
      setTaskInputMessage,
      enableDeepThinking: false,
      enableClarification: false,
      externalApiParams: options.externalApiParams ?? {},
      attachments: (options.attachments ?? []) as never,
      resetAttachment,
      isAttachmentReadyToSend: options.isAttachmentReadyToSend ?? true,
      taskType: options.taskType ?? 'chat',
      knowledgeBaseId: options.knowledgeBaseId,
      shouldHideChatInput: false,
      scrollToBottom: jest.fn(),
      selectedContexts,
      selectedDocumentIds: options.selectedDocumentIds,
      resetContexts,
      additionalSkills: [],
    })
  )
  return { ...hook, setTaskInputMessage, resetAttachment, resetContexts }
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
        data: { knowledge_id: 5, name: 'Product Docs', document_count: 3 },
      },
      {
        type: 'external_knowledge',
        data: {
          provider: 'demo',
          mode: 'explicit',
          id: 'lib-1',
          name: 'Lib One',
          scope: 'org',
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

  it('sends a dynamic DingTalk scope without rewriting a pasted DingTalk link', async () => {
    const dingtalkScope: ContextItem = {
      type: 'dingtalk_doc',
      id: 'dingtalk-scope:wikispace:space-1',
      name: '研发空间',
      doc_url: 'https://alidocs.dingtalk.com/i/spaces/space-1/overview',
      node_type: 'folder',
      dingtalk_node_id: 'space-1',
      source: 'wikispace',
      container_id: 'space-1',
      container_name: '研发空间',
      scope_mode: 'custom',
      folder_ids: ['folder-1'],
      document_ids: ['document-1'],
      excluded_node_ids: ['document-2'],
      include_descendants: true,
    }
    const pastedLink = 'https://alidocs.dingtalk.com/i/nodes/document-3'
    const { result } = renderSendHook([dingtalkScope])

    await act(async () => {
      await result.current.handleSendMessage(pastedLink)
    })

    const request = mockContextSendMessage.mock.calls[0][0]
    expect(request.message).toBe(pastedLink)
    expect(request.contexts).toEqual([
      {
        type: 'external_knowledge',
        data: {
          provider: 'dingtalk',
          mode: 'explicit',
          id: 'space-1',
          name: '研发空间',
          scope: 'wikispace',
          target_type: 'knowledge_base',
          scope_mode: 'custom',
          folder_ids: ['folder-1'],
          document_ids: ['document-1'],
          excluded_node_ids: ['document-2'],
          include_descendants: true,
        },
      },
    ])
  })

  it('sends a strict current-KB scope with selected notebook documents', async () => {
    const { result } = renderSendHook([], {
      taskType: 'knowledge',
      knowledgeBaseId: 12,
      selectedDocumentIds: [101, 102],
    })

    await act(async () => {
      await result.current.handleSendMessage()
    })

    expect(mockContextSendMessage.mock.calls[0][0].contexts).toEqual([
      {
        type: 'knowledge_base',
        data: {
          knowledge_id: 12,
          document_ids: [101, 102],
          scope_restricted: true,
        },
      },
      {
        type: 'selected_documents',
        data: {
          knowledge_base_id: 12,
          document_ids: [101, 102],
        },
      },
    ])
  })

  it('sends Artifact node identity without trusting the current document selection', async () => {
    const currentContext: ContextItem = {
      type: 'knowledge_base',
      id: 99,
      name: 'Unrelated KB',
      document_count: 1,
    } as ContextItem
    const attachment = {
      id: 88,
      filename: 'draft.pdf',
      status: 'uploading',
    }
    const { result, setTaskInputMessage, resetAttachment, resetContexts } = renderSendHook(
      [currentContext],
      {
        taskType: 'knowledge',
        knowledgeBaseId: 12,
        selectedDocumentIds: [999],
        attachments: [attachment],
        isAttachmentReadyToSend: false,
        externalApiParams: { token: 'draft-value' },
      }
    )

    await act(async () => {
      await result.current.handleSendMessage('解释这个节点', {
        artifactContext: {
          artifact_id: 'artifact-1',
          node_id: 'node-2',
        },
      })
    })

    const request = mockContextSendMessage.mock.calls[0][0]
    expect(request.artifact_context).toEqual({
      artifact_id: 'artifact-1',
      node_id: 'node-2',
    })
    expect(request.message).toBe('解释这个节点')
    expect(request.attachment_ids).toEqual([])
    expect(request.contexts).toBeUndefined()
    expect(setTaskInputMessage).not.toHaveBeenCalled()
    expect(resetAttachment).not.toHaveBeenCalled()
    expect(resetContexts).not.toHaveBeenCalled()
  })

  it('preserves Artifact node identity when a failed send is retried', async () => {
    const artifactContext = {
      artifact_id: 'artifact-1',
      node_id: 'node-2',
    }
    const { result } = renderSendHook([], {
      taskType: 'knowledge',
      knowledgeBaseId: 12,
    })

    await act(async () => {
      await result.current.handleSendMessage('解释这个节点', { artifactContext })
    })
    act(() => {
      mockContextSendMessage.mock.calls[0][1].onError(new Error('network error'))
    })

    render(mockToast.mock.calls[0][0].action)
    fireEvent.click(screen.getByRole('button', { name: 'chat:actions.retry' }))

    await waitFor(() => expect(mockContextSendMessage).toHaveBeenCalledTimes(2))
    expect(mockContextSendMessage.mock.calls[1][0].artifact_context).toEqual(artifactContext)
  })

  it('replaces the current-KB context with an explicit whole-KB scope', async () => {
    const existingContext: ContextItem = {
      type: 'knowledge_base',
      id: 12,
      name: 'Current KB',
      document_ids: [101],
      scope_restricted: true,
    }
    const { result } = renderSendHook([existingContext], {
      taskType: 'knowledge',
      knowledgeBaseId: 12,
      selectedDocumentIds: [],
    })

    await act(async () => {
      await result.current.handleSendMessage()
    })

    expect(mockContextSendMessage.mock.calls[0][0].contexts).toEqual([
      {
        type: 'knowledge_base',
        data: {
          knowledge_id: 12,
          document_ids: [],
          scope_restricted: false,
        },
      },
    ])
  })
})
