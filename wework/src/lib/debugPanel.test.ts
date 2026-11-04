import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import { EMPTY_CLOUD_WORK_STATUS } from '@/features/workbench/workbenchCloudStatus'
import { initialWorkbenchState } from '@/features/workbench/workbenchReducer'
import { describe, expect, it } from 'vitest'
import {
  getWorkbenchDebugSnapshot,
  updateRuntimePaneDebugSnapshot,
  updateWorkbenchDebugSnapshot,
} from './debugPanel'

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
  it('exports device diagnostics without raw connection configuration', () => {
    const device = {
      id: 1,
      device_id: 'device-1',
      name: 'Device',
      status: 'online' as const,
      is_default: true,
      cloud_config: { ubuntuInitialPassword: 'secret-cloud-value' },
      remote_config: { password: 'secret-remote-value' },
    }
    updateWorkbenchDebugSnapshot({
      state: { ...initialWorkbenchState, devices: [device] },
      lifecycle: new RuntimeTaskLifecycleStore('device-debug-test').getSnapshot(),
      taskReminders: { unreadCount: 0 },
      cloudWorkStatus: EMPTY_CLOUD_WORK_STATUS,
    })
    const devices = getWorkbenchDebugSnapshot().workbench?.devices
    expect(devices?.[0]).toMatchObject({ device_id: 'device-1', status: 'online' })
    expect(JSON.stringify(devices)).not.toContain('secret-')
    expect(devices?.[0]).not.toHaveProperty('cloud_config')
    expect(devices?.[0]).not.toHaveProperty('remote_config')
  })

  it.each(['threadId', 'thread_id'])('resolves the pane identity from runtimeHandle.%s', key => {
    const snapshot = createPaneSnapshot('loaded-task')
    snapshot.currentRuntimeTask!.runtimeHandle = { [key]: 'loaded-thread' }

    updateRuntimePaneDebugSnapshot(snapshot)

    expect(getWorkbenchDebugSnapshot().pane?.currentRuntimeTask?.threadId).toBe('loaded-thread')
  })

  it('keeps the explicit pane thread identity ahead of a retained runtime handle', () => {
    const snapshot = createPaneSnapshot('loaded-task')
    snapshot.currentRuntimeTask!.threadId = 'current-thread'
    snapshot.currentRuntimeTask!.runtimeHandle = { threadId: 'retained-thread' }

    updateRuntimePaneDebugSnapshot(snapshot)

    expect(getWorkbenchDebugSnapshot().pane?.currentRuntimeTask?.threadId).toBe('current-thread')
  })

  it('captures lifecycle execution fields without model options or runtime credentials', () => {
    const address = { deviceId: 'device-1', taskId: 'active-task' }
    const store = new RuntimeTaskLifecycleStore('debug-snapshot-test')
    store.syncRuntimeTask(address, {
      taskId: address.taskId,
      workspacePath: '/workspace',
      title: 'Task',
      runtime: 'codex',
      status: 'done',
      running: false,
      threadStatus: 'idle',
      turnStatus: 'completed',
      completedAt: 1234,
      updatedAt: 1234,
      runtimeHandle: { apiKey: 'secret-runtime-value' },
      modelSelection: { modelName: 'test-model', options: { api_key: 'secret-model-value' } },
    })

    updateWorkbenchDebugSnapshot({
      state: { ...initialWorkbenchState, currentRuntimeTask: address },
      lifecycle: store.getSnapshot(),
      taskReminders: { unreadCount: 0 },
      cloudWorkStatus: EMPTY_CLOUD_WORK_STATUS,
    })

    const lifecycle = getWorkbenchDebugSnapshot().workbench?.activeLifecycle
    expect(lifecycle?.task).toEqual({
      taskId: 'active-task',
      executionState: null,
      status: 'done',
      running: false,
      threadStatus: 'idle',
      turnStatus: 'completed',
      completedAt: 1234,
      updatedAt: 1234,
    })
    expect(lifecycle?.execution.running).toBe(false)
    expect(JSON.stringify(lifecycle)).not.toContain('secret-')
  })

  it('keeps the active pane snapshot when an inactive pane updates', () => {
    updateRuntimePaneDebugSnapshot(createPaneSnapshot('active-task'))
    updateRuntimePaneDebugSnapshot(createPaneSnapshot('hidden-task'), { enabled: false })

    expect(getWorkbenchDebugSnapshot().pane?.currentRuntimeTask?.taskId).toBe('active-task')
  })
})
