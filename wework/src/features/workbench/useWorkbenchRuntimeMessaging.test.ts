import i18n from '@/i18n'
import type { Attachment, DeviceInfo, RuntimeTaskAddress, UnifiedModel } from '@/types/api'
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { RuntimeTaskModelSelectionControls } from './workbenchContextTypes'
import {
  applyRuntimeConversationAction,
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationTurns,
  reconcileRuntimeConversationSnapshot,
} from './runtimeConversationCache'
import { createRuntimeTaskStreamHandlers } from './runtimePaneMessages'
import { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle/RuntimeTaskLifecycleStore'
import {
  buildRuntimeTaskCreateHandle,
  friendlyTitleForTask,
  loadTemporaryChatSource,
  prepareRuntimeAttachmentsForDevice,
  resolveRuntimeTaskCreateWorkspacePath,
  resolveTemporaryChatSource,
  runtimeExecutablePathForTarget,
  runtimeSendError,
  runtimeThreadId,
  useWorkbenchRuntimeMessaging,
} from './useWorkbenchRuntimeMessaging'
import { initialWorkbenchState } from './workbenchReducer'

function messagingFixture(
  modelState: {
    models?: UnifiedModel[]
    isSelectionReady?: boolean
    isConfiguredModelUnavailable?: boolean
  } = {},
  taskSelectionState: Partial<RuntimeTaskModelSelectionControls> = {}
) {
  const address = { deviceId: 'cancel-device', taskId: 'cancel-task' }
  const store = new RuntimeTaskLifecycleStore('messaging-cancellation-test')
  store.syncRuntimeTask(address, {
    taskId: address.taskId,
    title: 'Cancellation test',
    runtime: 'codex',
    running: true,
    continuable: true,
  })
  const cancel = vi.fn().mockResolvedValue({ accepted: true })
  const send = vi.fn().mockResolvedValue({ accepted: true })
  const compact = vi.fn().mockResolvedValue({ accepted: true })
  const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  type Options = Parameters<typeof useWorkbenchRuntimeMessaging>[0]
  const options: Options = {
    state: { ...initialWorkbenchState, currentRuntimeTask: address },
    dispatch: vi.fn(),
    executorClient: {
      runtime: { cancelRuntimeTask: cancel, sendRuntimeMessage: send, compactRuntimeTask: compact },
    } as unknown as Options['executorClient'],
    services: { taskApi: {} } as unknown as Options['services'],
    runtimeTasks: {} as Options['runtimeTasks'],
    lifecycleStore: store,
    projectExecutionMode: 'default',
    projectWorktreeBranch: null,
    isOptionsLocked: false,
    attachmentSelection: { attachments: [], resetAttachments: vi.fn() },
    modelSelection: { models: [], selectedModel: null, selectedModelOptions: {}, ...modelState },
    resolveRuntimeTaskModelSelection: () => ({
      selectionResolved: false,
      selectionReady: false,
      taskSelection: null,
      selectedModel: null,
      activeModel: null,
      selectedModelOptions: {},
      ...taskSelectionState,
    }),
    skillSelection: { selectedSkills: [] },
    refreshWorkLists: refresh,
  }
  const { result } = renderHook(() => useWorkbenchRuntimeMessaging(options))
  return { address, store, cancel, send, compact, refresh, messaging: result.current }
}

function cacheAsyncQuestion(
  address: RuntimeTaskAddress,
  payload: { interactionStatus?: 'cancelled'; expiresAtUnixMs?: number } = {}
) {
  reconcileRuntimeConversationSnapshot(address, [
    {
      id: 'async-turn',
      status: 'done',
      items: [
        {
          id: 'async-question',
          type: 'block',
          block: {
            id: 'async-question',
            type: 'tool',
            toolName: 'request_user_input',
            status: 'done',
            createdAt: 1,
            renderPayload: {
              kind: 'request_user_input',
              delivery: 'async',
              itemId: 'async-question',
              questions: [{ id: 'audience', question: 'Audience?' }],
              ...payload,
            },
          },
        },
      ],
    },
  ])
}

test('compaction renders only its native turn and remains active after an early RPC response', async () => {
  const { address, store, compact, messaging } = messagingFixture()
  let finish!: (value: { accepted: boolean }) => void
  compact.mockReturnValue(
    new Promise(resolve => {
      finish = resolve
    })
  )
  const sending = messaging.compactRuntimePaneTask({
    ...address,
    runtimeHandle: { modelSelection: { modelName: 'test-model' } },
  })
  try {
    await waitFor(() => expect(compact).toHaveBeenCalledOnce())
    expect(getRuntimeConversationTurns(address)).toEqual([])
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onRuntimeTurnUpdated: payload => {
        if (payload.task) store.syncRuntimeTask(address, payload.task)
      },
      onMessageAction: action => applyRuntimeConversationAction(address, action),
    })
    handlers.onRuntimeTurnUpdated?.({
      ...address,
      status: 'started',
      turnId: 'native-compact',
      task: {
        taskId: address.taskId,
        title: 'Compaction',
        workspacePath: '/workspace',
        runtime: 'codex',
        running: true,
        executionState: {
          revision: '2',
          phase: 'running',
          turnId: 'native-compact',
          latestTurnId: 'native-compact',
          outcome: null,
        },
      },
    })
    handlers.onBlockCreated?.({
      ...address,
      subtaskId: 'native-compact',
      block: {
        id: 'native-item',
        type: 'tool',
        tool_name: 'context_compaction',
        status: 'pending',
      },
    })
    finish({ accepted: true })
    await expect(sending).resolves.toBe(true)
    expect(store.getTask(address)?.execution.running).toBe(true)
    expect(getRuntimeConversationTurns(address)).toHaveLength(1)
    expect(getRuntimeConversationTurns(address)[0]).toMatchObject({
      id: 'native-compact',
      status: 'streaming',
      items: [{ id: 'native-item', block: { toolName: 'context_compaction', status: 'pending' } }],
    })
  } finally {
    finish({ accepted: true })
    await sending
    store.remove(address)
    clearRuntimeConversationCacheForTests()
  }
})

test.each(['accepted', 'queued'] as const)(
  'reports an %s send before unrelated work-list refresh completes',
  async status => {
    const { address, store, send, refresh, messaging } = messagingFixture()
    let finishRefresh!: () => void
    refresh.mockImplementationOnce(() => new Promise<void>(resolve => (finishRefresh = resolve)))
    send.mockResolvedValueOnce({ accepted: true, status })
    const queued = vi.fn()
    let delivered = false
    const sending = messaging
      .sendRuntimePaneMessage(
        { address, message: 'Continue', modelId: 'test-model' },
        { onQueued: queued }
      )
      .then(accepted => {
        delivered = accepted
      })
    try {
      await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
      await waitFor(() => expect(delivered).toBe(true))
      expect(queued).toHaveBeenCalledTimes(status === 'queued' ? 1 : 0)
    } finally {
      finishRefresh()
      await sending
      store.remove(address)
    }
  }
)

describe('runtime pane cancellation', () => {
  test.each(['accepted', 'refresh-failed', 'rejected', 'transport-failed'] as const)(
    'returns the executor cancellation outcome when %s',
    async outcome => {
      const { address, store, cancel, refresh, messaging } = messagingFixture()
      const onError = vi.fn()
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const accepted = outcome === 'accepted' || outcome === 'refresh-failed'
      if (outcome === 'refresh-failed') refresh.mockRejectedValue(new Error('Refresh unavailable'))
      if (outcome === 'rejected') {
        cancel.mockResolvedValue({ accepted: false, error: 'Cancellation rejected' })
      }
      if (outcome === 'transport-failed')
        cancel.mockRejectedValue(new Error('Transport unavailable'))

      try {
        await expect(messaging.cancelRuntimePaneTask(address, { onError })).resolves.toBe(accepted)
        expect(cancel).toHaveBeenCalledWith(address)
        expect(store.getTask(address)?.execution.phase).toBe(accepted ? 'stopping' : 'running')
        expect(refresh).toHaveBeenCalledTimes(accepted ? 1 : 0)
        expect(onError).toHaveBeenCalledTimes(accepted ? 0 : 1)
        expect(warning).toHaveBeenCalledTimes(outcome === 'refresh-failed' ? 1 : 0)
      } finally {
        warning.mockRestore()
        store.remove(address)
      }
    }
  )
})

describe.each([{ isSelectionReady: false }, { isConfiguredModelUnavailable: true }])(
  'runtime question responses with unavailable composer model %j',
  modelState => {
    test.each([true, false])(
      'preserves native acceptance for an async reply while composer discovery is unavailable (accepted=%s)',
      async accepted => {
        const { address, store, send, messaging } = messagingFixture(modelState)
        send.mockResolvedValue({ accepted })
        cacheAsyncQuestion(address)
        const onError = vi.fn()
        const destination = {
          ...address,
          runtimeHandle: { modelSelection: { modelName: 'task-model' } },
        }
        try {
          await expect(
            messaging.sendRuntimePaneMessage(
              { address: destination, message: 'owner' },
              { onError }
            )
          ).resolves.toBe(accepted)
          expect(send).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              address: destination,
              message: 'owner',
              modelId: 'task-model',
              modelSelection: { modelName: 'task-model', modelType: null, options: {} },
            })
          )
          if (accepted) expect(onError).not.toHaveBeenCalled()
          else expect(onError).toHaveBeenCalledWith('发送失败')
        } finally {
          store.remove(address)
          clearRuntimeConversationCacheForTests()
        }
      }
    )

    test.each(['expired', 'cancelled', 'another-task'] as const)(
      'does not treat a question from %s as a current async reply',
      async scope => {
        const { address, store, send, messaging } = messagingFixture(modelState)
        cacheAsyncQuestion(
          scope === 'another-task' ? { ...address, taskId: 'other-task' } : address,
          scope === 'expired'
            ? { expiresAtUnixMs: 1 }
            : scope === 'cancelled'
              ? { interactionStatus: 'cancelled' }
              : {}
        )
        const onError = vi.fn()
        try {
          expect(
            await messaging.sendRuntimePaneMessage({ address, message: 'Continue' }, { onError })
          ).toBe(false)
          expect(send).not.toHaveBeenCalled()
          expect(onError).toHaveBeenCalledWith(i18n.t('workbench.harness_model_required'))
        } finally {
          store.remove(address)
          clearRuntimeConversationCacheForTests()
        }
      }
    )

    test.each(['requestUserInputResponse', 'request_user_input_response'] as const)(
      'delivers %s to the existing runtime request without resolving a model',
      async field => {
        const { address, store, send, messaging } = messagingFixture(modelState)
        const onError = vi.fn()
        const response = {
          requestId: 2,
          itemId: 'mcp_server_elicitation',
          interactionScope: 'running-turn',
          answers: { audience: { answers: ['owner'] } },
        }
        const request = { address, message: 'owner', [field]: response }
        try {
          await expect(messaging.sendRuntimePaneMessage(request, { onError })).resolves.toBe(true)
          expect(send).toHaveBeenCalledExactlyOnceWith(request)
          expect(onError).not.toHaveBeenCalled()
          expect(store.getTask(address)?.execution.phase).toBe('running')
        } finally {
          store.remove(address)
        }
      }
    )

    test('still blocks an ordinary message until its model is available', async () => {
      const { address, store, send, messaging } = messagingFixture(modelState)
      const onError = vi.fn()
      try {
        await expect(
          messaging.sendRuntimePaneMessage({ address, message: 'Continue' }, { onError })
        ).resolves.toBe(false)
        expect(send).not.toHaveBeenCalled()
        expect(onError).toHaveBeenCalledWith(i18n.t('workbench.harness_model_required'))
      } finally {
        store.remove(address)
      }
    })

    test('allows a send when the destination task has a ready pane selection', async () => {
      const { address, store, send, messaging } = messagingFixture(modelState, {
        selectionResolved: true,
        selectionReady: true,
      })
      const onError = vi.fn()
      try {
        await expect(
          messaging.sendRuntimePaneMessage(
            { address, message: 'Continue', modelId: 'replacement-model' },
            { onError }
          )
        ).resolves.toBe(true)
        expect(send).toHaveBeenCalledOnce()
        expect(onError).not.toHaveBeenCalled()
      } finally {
        store.remove(address)
      }
    })
  }
)

test('prepares a model-less send with the ready pane selection', async () => {
  const replacement = {
    name: 'replacement-model',
    type: 'runtime' as const,
    provider: 'local' as const,
  }
  const { address, store, send, messaging } = messagingFixture(
    { isSelectionReady: false, isConfiguredModelUnavailable: true },
    {
      selectionResolved: true,
      selectionReady: true,
      selectedModel: replacement,
      activeModel: replacement,
      selectedModelOptions: { collaborationMode: 'plan' },
    }
  )
  const onError = vi.fn()
  try {
    await expect(
      messaging.sendRuntimePaneMessage({ address, message: 'Continue' }, { onError })
    ).resolves.toBe(true)
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0][0]).toMatchObject({
      modelId: 'replacement-model',
      modelType: 'runtime',
      modelOptions: expect.objectContaining({ collaborationMode: 'plan' }),
    })
    expect(onError).not.toHaveBeenCalled()
  } finally {
    store.remove(address)
  }
})

test('keeps explicit request options over the ready pane selection options', async () => {
  const replacement = {
    name: 'replacement-model',
    type: 'runtime' as const,
    provider: 'local' as const,
  }
  const { address, store, send, messaging } = messagingFixture(
    { isSelectionReady: false, isConfiguredModelUnavailable: true },
    {
      selectionResolved: true,
      selectionReady: true,
      selectedModel: replacement,
      activeModel: replacement,
      selectedModelOptions: { collaborationMode: 'default' },
    }
  )
  try {
    await expect(
      messaging.sendRuntimePaneMessage(
        { address, message: 'Continue', modelOptions: { collaborationMode: 'plan' } },
        { onError: vi.fn() }
      )
    ).resolves.toBe(true)
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0][0]).toMatchObject({
      modelId: 'replacement-model',
      modelOptions: expect.objectContaining({ collaborationMode: 'plan' }),
    })
  } finally {
    store.remove(address)
  }
})

test('promotes an explicit request collaboration_mode alias over the task default', async () => {
  const replacement = {
    name: 'replacement-model',
    type: 'runtime' as const,
    provider: 'local' as const,
  }
  const { address, store, send, messaging } = messagingFixture(
    { isSelectionReady: false, isConfiguredModelUnavailable: true },
    {
      selectionResolved: true,
      selectionReady: true,
      selectedModel: replacement,
      activeModel: replacement,
      selectedModelOptions: { collaborationMode: 'default' },
    }
  )
  try {
    await expect(
      messaging.sendRuntimePaneMessage(
        { address, message: 'Continue', modelOptions: { collaboration_mode: 'plan' } },
        { onError: vi.fn() }
      )
    ).resolves.toBe(true)
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0][0]).toMatchObject({
      modelId: 'replacement-model',
      modelOptions: expect.objectContaining({
        collaboration_mode: 'plan',
        collaborationMode: 'plan',
      }),
    })
  } finally {
    store.remove(address)
  }
})

test('blocks a current-task send whose resolved model is compatibility-disabled', async () => {
  const disabled = {
    name: 'disabled-model',
    type: 'runtime' as const,
    provider: 'local' as const,
    compatibilityDisabled: true,
  }
  const { address, store, send, messaging } = messagingFixture(
    { models: [disabled] },
    {
      selectionResolved: true,
      selectionReady: false,
      selectedModel: disabled,
      activeModel: disabled,
    }
  )
  const onError = vi.fn()
  try {
    await expect(
      messaging.sendRuntimePaneMessage(
        { address, message: 'Continue', modelId: 'disabled-model' },
        { onError }
      )
    ).resolves.toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(i18n.t('workbench.harness_model_required'))
  } finally {
    store.remove(address)
  }
})

test('keeps a current-task send with a stale catalog model sendable', async () => {
  const missing = {
    name: 'missing-model',
    type: 'runtime' as const,
    provider: 'local' as const,
  }
  const { address, store, send, messaging } = messagingFixture(
    { models: [] },
    {
      selectionResolved: true,
      selectionReady: false,
      selectedModel: missing,
      activeModel: missing,
    }
  )
  try {
    await expect(
      messaging.sendRuntimePaneMessage(
        { address, message: 'Continue', modelId: 'missing-model' },
        { onError: vi.fn() }
      )
    ).resolves.toBe(true)
    expect(send).toHaveBeenCalledOnce()
  } finally {
    store.remove(address)
  }
})

describe('runtimeSendError', () => {
  test('localizes an unsupported remote Team backend', () => {
    expect(runtimeSendError(new Error('REMOTE_TEAM_BACKEND_UNSUPPORTED'), 'fallback')).toBe(
      i18n.t('workbench.remote_team_backend_unsupported')
    )
  })
})

describe('buildRuntimeTaskCreateHandle', () => {
  test('retains the Team identity before the runtime task is bound', () => {
    expect(buildRuntimeTaskCreateHandle(null, { wegentTeamId: 1880 })).toEqual({
      wegentTeam: { id: 1880 },
    })
  })
  test('keeps board ownership in the optimistic runtime address', () => {
    expect(
      buildRuntimeTaskCreateHandle(null, {
        cloudProjectId: 'project-1',
        origin: {
          type: 'board_task',
          cloudProjectId: 'project-1',
          loopItemId: 'ISSUE-1',
          projectStore: 'backend',
        },
      })
    ).toEqual({
      cloudProjectId: 'project-1',
      origin: {
        type: 'board_task',
        cloudProjectId: 'project-1',
        loopItemId: 'ISSUE-1',
        projectStore: 'backend',
      },
    })
  })
})

describe('resolveRuntimeTaskCreateWorkspacePath', () => {
  test('requires the Executor planned path for a managed workspace task', () => {
    expect(() =>
      resolveRuntimeTaskCreateWorkspacePath({
        sourcePath: '/workspace/project',
        requestedManagedWorkspace: true,
      })
    ).toThrow('did not return a planned workspace path')
  })

  test('rejects a managed workspace response that falls back to the base workspace', () => {
    expect(() =>
      resolveRuntimeTaskCreateWorkspacePath({
        sourcePath: '/workspace/project/',
        responsePath: '/workspace/project',
        requestedManagedWorkspace: true,
      })
    ).toThrow('returned the base workspace path')
  })
})

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: -1,
    filename: 'screenshot.png',
    file_size: 4,
    mime_type: 'image/png',
    status: 'ready',
    file_extension: '.png',
    created_at: '2026-08-11T00:00:00.000Z',
    local_path: '/Users/me/.wework/workspace/attachments/draft/screenshot.png',
    ...overrides,
  }
}

function device(deviceId: string, deviceType: DeviceInfo['device_type']): DeviceInfo {
  return {
    id: 1,
    device_id: deviceId,
    name: deviceId,
    status: 'online',
    is_default: false,
    device_type: deviceType,
  }
}

describe('runtimeThreadId', () => {
  test('falls back to the runtime handle thread id', () => {
    expect(
      runtimeThreadId({
        deviceId: 'local-device',
        taskId: 'task-1',
        runtimeHandle: { threadId: 'thread-from-handle' },
      })
    ).toBe('thread-from-handle')
  })
})

describe('resolveTemporaryChatSource', () => {
  test('hydrates a stale source address from the runtime work list', () => {
    expect(
      resolveTemporaryChatSource(
        {
          deviceId: 'local-device',
          taskId: 'task-1',
          runtimeHandle: { modelSelection: { modelName: 'gpt-5' } },
        },
        {
          projects: [],
          chats: [
            {
              deviceId: 'local-device',
              workspacePath: '/workspace',
              available: true,
              mapped: true,
              tasks: [
                {
                  taskId: 'task-1',
                  threadId: 'thread-1',
                  workspacePath: '/workspace',
                  title: 'Task',
                  runtime: 'codex',
                  runtimeHandle: { threadId: 'thread-1' },
                },
              ],
            },
          ],
          totalTasks: 1,
        }
      )
    ).toEqual({
      deviceId: 'local-device',
      taskId: 'task-1',
      runtime: 'codex',
      threadId: 'thread-1',
      workspacePath: '/workspace',
      runtimeHandle: {
        modelSelection: { modelName: 'gpt-5' },
        threadId: 'thread-1',
      },
    })
  })

  test('loads fresh runtime work when the cached source has no thread id', async () => {
    const listRuntimeWork = vi.fn().mockResolvedValue({
      projects: [],
      chats: [
        {
          deviceId: 'local-device',
          workspacePath: '/workspace',
          available: true,
          mapped: true,
          tasks: [
            {
              taskId: 'task-1',
              threadId: 'thread-1',
              workspacePath: '/workspace',
              title: 'Task',
              runtime: 'codex',
            },
          ],
        },
      ],
      totalTasks: 1,
    })

    await expect(
      loadTemporaryChatSource(
        {
          deviceId: 'local-device',
          taskId: 'task-1',
          runtimeHandle: { modelSelection: { modelName: 'gpt-5' } },
        },
        null,
        listRuntimeWork
      )
    ).resolves.toMatchObject({
      deviceId: 'local-device',
      taskId: 'task-1',
      threadId: 'thread-1',
      workspacePath: '/workspace',
    })
    expect(listRuntimeWork).toHaveBeenCalledTimes(1)
  })
})

describe('friendlyTitleForTask', () => {
  const taskExecutionModel = {
    modelId: 'local-model:current',
    modelType: 'runtime' as const,
    modelOptions: { collaborationMode: 'default' },
  }

  test('skips title generation when the previously selected title model is gone', () => {
    expect(
      friendlyTitleForTask(
        {
          friendlyTaskTitlesEnabled: true,
          friendlyTaskTitleModel: {
            modelName: 'local-model:removed',
            modelType: 'runtime',
            executionModelId: 'local-model:removed',
            executionModelType: 'runtime',
          },
        },
        [{ name: 'local-model:current', type: 'runtime' }] as never,
        taskExecutionModel
      )
    ).toBeNull()
  })
})

describe('prepareRuntimeAttachmentsForDevice', () => {
  test.each(['cloud', 'remote'] as const)(
    'uploads a source file before sending to a %s device',
    async deviceType => {
      const localAttachment = attachment({
        local_path: 'C:\\Users\\alice\\Downloads\\screenshot.png',
      })
      const uploadedAttachment = attachment({ id: 42, local_path: undefined })
      const existingAttachment = attachment({
        id: 8,
        local_path: '/cloud/attachment.png',
        local_preview_url: '/cloud/attachment.png',
      })
      const upload = vi.fn().mockResolvedValue(uploadedAttachment)

      await expect(
        prepareRuntimeAttachmentsForDevice(
          'cloud-device',
          [device('cloud-device', deviceType)],
          [7],
          [localAttachment, existingAttachment],
          upload
        )
      ).resolves.toEqual({
        attachmentIds: [7, 8, 42],
        attachments: [
          attachment({
            id: 8,
            local_path: undefined,
            local_preview_url: undefined,
          }),
          uploadedAttachment,
        ],
      })
      expect(upload).toHaveBeenCalledWith(localAttachment)
    }
  )

  test('blocks cloud sending when local attachment upload is unavailable', async () => {
    await expect(
      prepareRuntimeAttachmentsForDevice(
        'cloud-device',
        [device('cloud-device', 'cloud')],
        [],
        [attachment()]
      )
    ).rejects.toThrow('当前无法将本地附件上传到云设备')
  })
})

describe('runtimeExecutablePathForTarget', () => {
  test('keeps a configured executable while local device discovery is pending', () => {
    expect(
      runtimeExecutablePathForTarget({
        executablePath: '/tmp/claude',
        targetDevice: null,
      })
    ).toBe('/tmp/claude')
  })

  test('prefers an explicit remote executor over stale local workspace metadata', () => {
    expect(
      runtimeExecutablePathForTarget({
        executablePath: '/tmp/claude',
        targetDevice: {
          device_id: 'remote-device',
          device_type: 'cloud',
          status: 'online',
        },
        workspaceSource: 'local',
      })
    ).toBeUndefined()
  })
})
