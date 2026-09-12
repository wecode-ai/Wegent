import { describe, expect, it } from 'vitest'
import { getWorkbenchDebugSnapshot, updateRuntimePaneDebugSnapshot } from './debugPanel'

type PaneSnapshotInput = Parameters<typeof updateRuntimePaneDebugSnapshot>[0]

function createPaneSnapshot(taskId: string): PaneSnapshotInput {
  return {
    currentRuntimeTask: {
      deviceId: 'device-1',
      taskId,
    },
    status: {} as PaneSnapshotInput['status'],
    messageSummary: {
      total: 0,
      byRole: {},
      byStatus: {},
      activeAssistantMessage: null,
      lastMessage: null,
    },
    messageStyleComparison: {
      transcriptLoaded: null,
      currentStreaming: null,
      fieldDiff: [],
      renderingRules: [],
    },
    memory: {
      messages: {
        count: 0,
        contentChars: 0,
        blockCount: 0,
        toolBlockCount: 0,
        toolOutputApproxChars: 0,
        renderPayloadApproxChars: 0,
        attachmentCount: 0,
        attachmentPathChars: 0,
        referenceCount: 0,
        memoryCitationCount: 0,
        topToolOutputs: [],
      },
      currentRuntimeTask: null,
      transcript: {
        loadedRangeCount: 0,
        loadedRanges: [],
        loadedMessageSlots: 0,
      },
      dom: {
        messageNodes: 0,
        processingBlockNodes: 0,
        codeBlocks: 0,
      },
    },
    queuedMessages: [],
    guidanceMessages: [],
    codeCommentContextCount: 0,
    inputLength: 0,
    transcript: {
      loading: false,
      hasMoreBefore: false,
      loadingMoreBefore: false,
      turnNavigationCount: 0,
      loadedRanges: [],
    },
    subagentStatuses: [],
    goal: null,
    goalDraftActive: false,
  }
}

describe('runtime pane debug snapshot', () => {
  it('keeps the active pane snapshot when an inactive pane updates', () => {
    updateRuntimePaneDebugSnapshot(createPaneSnapshot('active-task'))
    updateRuntimePaneDebugSnapshot(createPaneSnapshot('hidden-task'), { enabled: false })

    expect(getWorkbenchDebugSnapshot().pane?.currentRuntimeTask?.taskId).toBe('active-task')
  })

  it('stores only a summary of the active assistant message', () => {
    const snapshot = createPaneSnapshot('active-task')
    snapshot.status = {
      ...snapshot.status,
      activeAssistantMessage: {
        id: 'assistant-1',
        role: 'assistant',
        status: 'streaming',
        content: 'x'.repeat(10_000),
        createdAt: '2026-09-12T00:00:00.000Z',
        blocks: [
          {
            id: 'tool-1',
            type: 'tool',
            toolName: 'shell',
            toolInput: {},
            status: 'streaming',
            createdAt: Date.parse('2026-09-12T00:00:00.000Z'),
          },
        ],
      },
    }

    updateRuntimePaneDebugSnapshot(snapshot)

    expect(getWorkbenchDebugSnapshot().pane?.status.activeAssistantMessage).toEqual(
      expect.objectContaining({
        id: 'assistant-1',
        contentLength: 10_000,
        blockCount: 1,
      })
    )
    expect(getWorkbenchDebugSnapshot().pane?.status.activeAssistantMessage).not.toHaveProperty(
      'content'
    )
  })
})
