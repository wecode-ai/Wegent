import i18n from '@/i18n'
import { createPaneSubmissionCommands } from '@/components/layout/workbenchPaneSubmissionCommands'
import { createPaneQueueGoalCommands } from '@/components/layout/workbenchPaneQueueGoalCommands'
import { sendTemporaryChatMessage } from '@/components/layout/workspace-panels/temporaryChatSend'
import type { RuntimePaneQueuedMessage } from '@/types/workbench'
import type { Attachment, DeviceInfo, RuntimeTaskAddress, UnifiedModel } from '@/types/api'
import { act, renderHook, waitFor } from '@testing-library/react'
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
import { useWorkbenchAttachments } from './useWorkbenchAttachments'
import { useImageEditSubmission } from '@/components/layout/useImageEditSubmission'
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

test('queues saved image comments in a temporary chat and restores them as attachment data', async () => {
  const image: Attachment = {
    id: 1,
    filename: 'layout.png',
    file_size: 3,
    mime_type: 'image/png',
    file_extension: '.png',
    created_at: '',
    status: 'ready',
    image_markup_comments: [{ x: 36.7, y: 50.4, text: 'Look here' }],
  }
  const enqueue = vi.fn<(message: RuntimePaneQueuedMessage) => void>()
  const context = {
    address: { deviceId: 'device', taskId: 'task' },
    active: true,
    busy: true,
    input: '',
    instanceId: 'temporary',
    sideChatProjectChat: { attachments: [image], resetAttachments: vi.fn() },
    captureAttachmentsForScope: () => [image],
    canSendWithCurrentModel: () => true,
    sessionCommands: { isCurrent: () => true },
    setError: vi.fn(),
    setInput: vi.fn(),
    setTrialGuide: vi.fn(),
    conversationQueue: { enqueue },
  } as unknown as Parameters<typeof sendTemporaryChatMessage>[0]
  expect(await sendTemporaryChatMessage(context)).toBe(true)
  const [[message]] = enqueue.mock.calls
  expect(message.content).toMatch(/36\.7%.*50\.4%.*Look here/)

  const replaceInput = vi.fn()
  const addExistingAttachment = vi.fn()
  const pane = {
    frame: { addExistingAttachment, queuedMessageBusyBlocks: new Map(), queuedMessages: [message] },
    commands: { replaceInput, setQueuedMessages: vi.fn() },
  } as unknown as Parameters<typeof createPaneQueueGoalCommands>[0]
  createPaneQueueGoalCommands(pane).editQueuedMessage(message.id)
  expect(replaceInput).toHaveBeenCalledExactlyOnceWith('')
  expect(addExistingAttachment).toHaveBeenCalledExactlyOnceWith(image)
})

type TemporarySendContext = Parameters<typeof sendTemporaryChatMessage>[0]

function temporarySendContext({
  instanceId,
  attachments,
  captureAttachmentsForScope,
  resetAttachments,
  addExistingAttachment,
  sendRuntimePaneMessage,
  input = '',
  busy = false,
}: {
  instanceId: string
  attachments: Attachment[]
  captureAttachmentsForScope: TemporarySendContext['captureAttachmentsForScope']
  resetAttachments(): void
  addExistingAttachment(attachment: Attachment): void
  sendRuntimePaneMessage: TemporarySendContext['sendRuntimePaneMessage']
  input?: string
  busy?: boolean
}): TemporarySendContext {
  const address = { deviceId: 'device', taskId: 'task' }
  return {
    address,
    source: address,
    active: true,
    readOnly: false,
    nativeConversation: false,
    historySource: undefined,
    scopedHistory: { available: true },
    paneStatus: { isBusy: false },
    taskModelIdentityPending: false,
    sendConversationMessage: vi.fn(),
    t: (key: string) => key,
    goalDraftActive: false,
    createTask: vi.fn(),
    lifecycleStore: new RuntimeTaskLifecycleStore(instanceId),
    createTemporaryRuntimeTask: vi.fn(),
    currentProject: null,
    input,
    busy,
    conversationQueue: { enqueue: vi.fn() },
    queuePort: {},
    captureAttachmentsForScope,
    instanceId,
    sideChatProjectChat: { attachments, resetAttachments, addExistingAttachment },
    selectedModelFields: {},
    runtimeContext: undefined,
    sendQueuedMessageAsGuidance: vi.fn(),
    sendRuntimePaneMessage,
    interruptAndSendRuntimePaneMessage: vi.fn(),
    sendEphemeral: false,
    canSendWithCurrentModel: () => true,
    sessionStartFields: {},
    updateAddress: vi.fn(),
    setInput: vi.fn(),
    setError: vi.fn(),
    setTrialGuide: vi.fn(),
    setSending: vi.fn(),
    setMessages: vi.fn(),
    setAddress: vi.fn(),
    setGoalDraftActive: vi.fn(),
    setAcceptedSourceMessageIds: vi.fn(),
    sessionCommands: { isCurrent: () => true, nativeSubmissionPending: () => false },
  } as unknown as TemporarySendContext
}

test.each([
  ['successful transport', false],
  ['busy queue', true],
] as const)('keeps a newer draft attachment through a pending %s', async (_label, busy) => {
  const submitted: Attachment = {
    id: -1,
    filename: 'submitted.png',
    file_size: 3,
    mime_type: 'image/png',
    file_extension: '.png',
    created_at: '',
    status: 'ready',
    local_path: '/tmp/submitted.png',
  }
  const newer: Attachment = { ...submitted, id: -2, filename: 'newer.png' }
  const { result } = renderHook(() => useWorkbenchAttachments({ scopeKey: 'pending-send' }))
  act(() => result.current.addExistingAttachment(submitted))
  let finishSend!: () => void
  const sendRuntimePaneMessage = vi.fn(
    (_request: unknown, handlers: { onError?: (message: string) => void }) =>
      new Promise<boolean>(resolve => {
        finishSend = () => {
          if (busy) handlers.onError?.(i18n.t('workbench.runtime_task_running_message'))
          resolve(!busy)
        }
      })
  )
  const context = temporarySendContext({
    instanceId: 'pending-send',
    attachments: result.current.attachments,
    captureAttachmentsForScope: result.current.captureAttachmentsForScope,
    resetAttachments: result.current.resetAttachments,
    addExistingAttachment: result.current.addExistingAttachment,
    sendRuntimePaneMessage,
    input: 'Send the current draft',
  })

  let sending!: Promise<boolean>
  act(() => {
    sending = sendTemporaryChatMessage(context)
  })
  act(() => result.current.addExistingAttachment(newer))
  await act(async () => {
    finishSend()
    await expect(sending).resolves.toBe(true)
  })

  expect(sendRuntimePaneMessage).toHaveBeenCalledOnce()
  expect(result.current.attachments).toEqual([newer])
})

test('sends an appshot image and hidden companion for a draft image comment', async () => {
  const { resolvePreparingAttachments } = await import('@/lib/runtime-attachments')
  const existingComments = [{ x: 25, y: 40, text: 'Existing pin' }]
  const appshot: Attachment = {
    id: -10,
    filename: 'appshot.png',
    file_size: 10,
    mime_type: 'image/png',
    file_extension: '.png',
    created_at: '',
    status: 'ready',
    local_path: '/tmp/appshot.png',
    ui_group_id: 'appshot-capture-1',
    ui_group_role: 'primary',
    ui_kind: 'appshot',
    image_markup_comments: existingComments,
  }
  const companion: Attachment = {
    ...appshot,
    id: -11,
    filename: 'appshot-context.txt',
    mime_type: 'text/plain',
    file_extension: '.txt',
    local_path: '/tmp/appshot-context.txt',
    ui_group_role: 'companion',
    image_markup_comments: undefined,
  }
  const remove = vi.fn().mockResolvedValue(undefined)
  const { result: attachments } = renderHook(() =>
    useWorkbenchAttachments({ scopeKey: 'appshot-comment', deleteAttachment: remove })
  )
  act(() => {
    attachments.current.addExistingAttachment(appshot)
    attachments.current.addExistingAttachment(companion)
  })
  const sendRuntimePaneMessage = vi.fn().mockResolvedValue(true)
  const send = (
    message: string,
    options: { standaloneAttachments?: Attachment[]; draftAttachmentSourceId?: number }
  ) =>
    sendTemporaryChatMessage(
      temporarySendContext({
        instanceId: 'appshot-comment',
        attachments: attachments.current.attachments,
        captureAttachmentsForScope: attachments.current.captureAttachmentsForScope,
        resetAttachments: attachments.current.resetAttachments,
        addExistingAttachment: attachments.current.addExistingAttachment,
        sendRuntimePaneMessage,
      }),
      message,
      options
    )
  const upload = vi.fn(async (file: File) => ({
    ...appshot,
    id: 42,
    filename: file.name,
    local_path: '/tmp/appshot-comment.png',
    image_markup_comments: undefined,
  }))
  const { result: editor } = renderHook(() =>
    useImageEditSubmission({
      enabled: true,
      scope: 'appshot-comment',
      attachmentScope: 'appshot-comment',
      upload,
      submit: send,
      removeDraftAttachment: attachments.current.removeAttachmentForScope,
    })
  )
  const source = new File(['appshot'], appshot.filename, { type: appshot.mime_type })

  await act(async () => {
    await expect(
      editor.current!.submit(
        {
          name: source.name,
          mimeType: source.type,
          loadFile: async () => source,
          draftAttachmentId: appshot.id,
        },
        {
          kind: 'comment',
          comments: [...existingComments, { x: 70, y: 80, text: 'New pin' }],
        }
      )
    ).resolves.toBe(true)
  })

  const [request] = sendRuntimePaneMessage.mock.calls[0]!
  expect(request.message).toMatch(/Existing pin/)
  expect(request.message).toMatch(/New pin/)
  expect(request.attachments?.map((item: Attachment) => item.filename)).toEqual([
    'appshot.png',
    'appshot-context.txt',
  ])
  expect(
    (await resolvePreparingAttachments(request.attachments)).map(item => item.local_path)
  ).toEqual(['/tmp/appshot-comment.png', '/tmp/appshot-context.txt'])
  await waitFor(() => expect(attachments.current.attachments).toEqual([]))
  expect(remove).not.toHaveBeenCalled()
})

test.each([false, true])(
  'includes saved coordinates in Goal messages (existing task %s)',
  async existing => {
    const objective = 'Inspect the layout'
    const attachment: Attachment = {
      id: 1,
      filename: 'layout.png',
      file_size: 3,
      mime_type: 'image/png',
      file_extension: '.png',
      created_at: '',
      status: 'ready',
      image_markup_comments: [{ x: 36.7, y: 50.4, text: 'Look here' }],
    }
    const sendRuntimeMessage = vi.fn().mockResolvedValue({ accepted: true })
    const sendCurrentInput = vi.fn().mockResolvedValue(true)
    const context = {
      frame: {
        attachmentState: { captureAttachments: () => [attachment] },
        codeCommentContexts: [],
        currentRuntimeTask: existing ? { deviceId: 'device', taskId: 'task' } : null,
        goalDraftActive: true,
        input: objective,
        inputScopeKey: 'draft',
        inputRevision: 0,
        sharedInputRevision: 0,
        getInputRevisionForScope: () => 0,
        lifecycleStore: new RuntimeTaskLifecycleStore('goal-markup-test'),
        resetAttachments: vi.fn(),
        sendCurrentInput,
      },
      actions: { setPendingGoalState: vi.fn() },
      commands: {
        getDraftEditVersion: () => 0,
        getRuntimeModelFields: () => ({}),
        readCurrentPaneBusy: () => false,
        setError: vi.fn(),
        setGoalDraftActive: vi.fn(),
        clearCodeCommentsAfterCommit: vi.fn(),
        appendLocalUserMessage: vi.fn(),
        sendRuntimeMessage,
      },
      live: { mounted: false },
    } as unknown as Parameters<typeof createPaneSubmissionCommands>[0]
    expect(await createPaneSubmissionCommands(context).send()).toBe(true)
    const [message, options] = (existing ? sendRuntimeMessage : sendCurrentInput).mock.calls[0]!
    expect(existing ? message.content : message).toMatch(/36\.7%.*50\.4%.*Look here/)
    expect(options.initialGoal.objective).toBe(objective)
    const [image] = existing ? message.attachments : options.attachments
    if (existing) {
      expect(message.imageMarkupDraftText).toBe(objective)
      expect(image.image_markup_comments).toEqual(attachment.image_markup_comments)
    } else {
      expect(image).not.toHaveProperty('image_markup_comments')
    }
  }
)

test.each([true, false])(
  'sends the appshot group from a main pane image comment and cleans it only after acceptance: %s',
  async accepted => {
    const appshot: Attachment = {
      id: -10,
      filename: 'appshot.png',
      file_size: 10,
      mime_type: 'image/png',
      file_extension: '.png',
      created_at: '',
      status: 'ready',
      local_path: '/tmp/appshot.png',
      ui_group_id: 'appshot-main-pane',
      ui_group_role: 'primary',
      ui_kind: 'appshot',
    }
    const companion: Attachment = {
      ...appshot,
      id: -11,
      filename: 'appshot-context.txt',
      mime_type: 'text/plain',
      file_extension: '.txt',
      local_path: '/tmp/appshot-context.txt',
      ui_group_role: 'companion',
    }
    const newerDraft: Attachment = {
      ...appshot,
      id: -12,
      filename: 'newer-draft.png',
      local_path: '/tmp/newer-draft.png',
      ui_group_id: undefined,
      ui_group_role: undefined,
      ui_kind: undefined,
    }
    const submitted: Attachment = {
      ...appshot,
      id: -20,
      filename: 'appshot-comment.png',
      local_path: '/tmp/appshot-comment.png',
    }
    const { result: attachments } = renderHook(() =>
      useWorkbenchAttachments({ scopeKey: 'main-appshot' })
    )
    act(() => {
      attachments.current.addExistingAttachment(appshot)
      attachments.current.addExistingAttachment(companion)
      attachments.current.addExistingAttachment(newerDraft)
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({ accepted, queued: false })
    const sendCurrentInput = vi.fn()
    const resetDraftAttachments = vi.fn()
    const context = {
      frame: {
        attachmentState: {
          ...attachments.current,
          captureAttachments: attachments.current.captureAttachments,
          removeAttachment: attachments.current.removeAttachment,
        },
        codeCommentContexts: [],
        currentRuntimeTask: { deviceId: 'device', taskId: 'task' },
        goalDraftActive: false,
        input: '',
        inputScopeKey: 'main-appshot',
        inputRevision: 0,
        sharedInputRevision: 0,
        getInputRevisionForScope: () => 0,
        lifecycleStore: new RuntimeTaskLifecycleStore('main-appshot'),
        resetAttachments: resetDraftAttachments,
        sendCurrentInput,
      },
      actions: { setPendingGoalState: vi.fn(), setDraftMessages: vi.fn() },
      commands: {
        getDraftEditVersion: () => 0,
        getRuntimeModelFields: () => ({}),
        readCurrentPaneBusy: () => false,
        setError: vi.fn(),
        setErrorForScope: vi.fn(),
        setGoalDraftActive: vi.fn(),
        clearCodeCommentsAfterCommit: vi.fn(),
        appendLocalUserMessage: vi.fn(),
        sendRuntimeMessage,
        retainRuntimeQueuedMessage: vi.fn(),
        setQueuedMessages: vi.fn(),
      },
      live: { mounted: false },
    } as unknown as Parameters<typeof createPaneSubmissionCommands>[0]

    await act(async () => {
      await expect(
        createPaneSubmissionCommands(context).send('Inspect the appshot', {
          standaloneAttachments: [submitted],
          draftAttachmentSourceId: appshot.id,
        })
      ).resolves.toBe(accepted)
    })

    const [queuedMessage] = sendRuntimeMessage.mock.calls[0]!
    expect(queuedMessage.content).toBe('Inspect the appshot')
    expect(queuedMessage.attachments.map((item: Attachment) => item.filename)).toEqual([
      'appshot-comment.png',
      'appshot-context.txt',
    ])
    expect(sendCurrentInput).not.toHaveBeenCalled()
    expect(resetDraftAttachments).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(attachments.current.attachments.map(item => item.filename)).toEqual(
        accepted ? ['newer-draft.png'] : ['appshot.png', 'appshot-context.txt', 'newer-draft.png']
      )
    )
  }
)

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
        {
          address,
          message: 'Continue',
          modelId: 'test-model',
          queueIfBusy: true,
          clientUserMessageId: 'durable-follow-up',
        },
        { onQueued: queued }
      )
      .then(accepted => {
        delivered = accepted
      })
    try {
      await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
      await waitFor(() => expect(delivered).toBe(true))
      expect(send).toHaveBeenCalledOnce()
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          address,
          message: 'Continue',
          queueIfBusy: true,
          clientUserMessageId: 'durable-follow-up',
        })
      )
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

  test('settles a send rejected after its optimistic cancellation', async () => {
    const { address, store, cancel, send, messaging } = messagingFixture()
    let finishSend!: (value: { accepted: boolean; taskId: string; code: string }) => void
    send.mockReturnValueOnce(
      new Promise(resolve => {
        finishSend = resolve
      })
    )
    const optimisticUserMessage = {
      id: 'cancelled-before-dispatch',
      role: 'user' as const,
      content: 'Old prompt',
      status: 'done' as const,
    }
    try {
      const sending = messaging.sendRuntimePaneMessage(
        {
          address,
          message: 'Old prompt',
          clientUserMessageId: optimisticUserMessage.id,
          modelId: 'test-model',
        },
        { optimisticUserMessage }
      )
      await waitFor(() => expect(send).toHaveBeenCalledOnce())
      await messaging.cancelRuntimePaneTask(address, {
        pendingClientUserMessageId: optimisticUserMessage.id,
      })
      finishSend({ accepted: false, code: 'cancelled', taskId: address.taskId })

      await expect(sending).resolves.toBe(true)
      expect(cancel).toHaveBeenCalledExactlyOnceWith({
        ...address,
        clientUserMessageId: optimisticUserMessage.id,
      })
      expect(store.getTask(address)).toMatchObject({
        execution: { phase: 'idle' },
        turn: { active: false, outcome: 'cancelled' },
      })
      expect(getRuntimeConversationTurns(address)).toEqual([])
    } finally {
      store.remove(address)
      clearRuntimeConversationCacheForTests()
    }
  })

  test('does not let a late cancelled send clear a newer send', async () => {
    const { address, store, send, messaging } = messagingFixture()
    const responses: Array<(value: { accepted: boolean; taskId: string; code?: string }) => void> =
      []
    send.mockImplementation(
      () =>
        new Promise(resolve => {
          responses.push(resolve)
        })
    )
    const firstMessage = {
      id: 'cancelled-before-dispatch',
      role: 'user' as const,
      content: 'Old prompt',
      status: 'done' as const,
    }
    const replacementMessage = {
      id: 'replacement-prompt',
      role: 'user' as const,
      content: 'Replacement prompt',
      status: 'done' as const,
    }
    let firstSending: Promise<boolean> | null = null
    let replacementSending: Promise<boolean> | null = null
    try {
      firstSending = messaging.sendRuntimePaneMessage(
        {
          address,
          message: firstMessage.content,
          clientUserMessageId: firstMessage.id,
          modelId: 'test-model',
        },
        { optimisticUserMessage: firstMessage }
      )
      await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
      await messaging.cancelRuntimePaneTask(address, {
        pendingClientUserMessageId: firstMessage.id,
      })

      replacementSending = messaging.sendRuntimePaneMessage(
        {
          address,
          message: replacementMessage.content,
          clientUserMessageId: replacementMessage.id,
          modelId: 'test-model',
        },
        { optimisticUserMessage: replacementMessage }
      )
      await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
      expect(store.getTask(address)?.execution.phase).toBe('starting')

      responses[0]({ accepted: false, code: 'cancelled', taskId: address.taskId })
      await expect(firstSending).resolves.toBe(true)

      expect(store.getTask(address)?.execution.phase).toBe('starting')
      expect(getRuntimeConversationTurns(address)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ clientUserMessageId: replacementMessage.id }),
        ])
      )

      responses[1]({ accepted: true, taskId: address.taskId })
      await expect(replacementSending).resolves.toBe(true)
    } finally {
      responses[0]?.({ accepted: false, code: 'cancelled', taskId: address.taskId })
      responses[1]?.({ accepted: true, taskId: address.taskId })
      await Promise.allSettled([
        firstSending ?? Promise.resolve(false),
        replacementSending ?? Promise.resolve(false),
      ])
      store.remove(address)
      clearRuntimeConversationCacheForTests()
    }
  })
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
  test('admits a deferred image attachment before reading its source and retains the file for retry', async () => {
    const { failedPreparationFile, localRuntimeAttachments, prepareAttachmentFile } =
      await import('@/lib/runtime-attachments')
    const source = new File(['image'], 'selection-mask.png', { type: 'image/png' })
    const load = vi.fn().mockResolvedValue(source)
    const upload = vi.fn().mockRejectedValue(new Error('staging failed'))
    const pending = prepareAttachmentFile(source.name, source.type, load, upload)

    expect(pending.status).toBe('uploading')
    await Promise.resolve()
    expect(load).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    await expect(
      prepareRuntimeAttachmentsForDevice('local-device', [], [], localRuntimeAttachments([pending]))
    ).rejects.toThrow('staging failed')
    expect(failedPreparationFile(pending)).toBe(source)
  })

  test('reports how to recover an unfinished attachment after its in-memory preparation is lost', async () => {
    await expect(
      prepareRuntimeAttachmentsForDevice(
        'local-device',
        [],
        [],
        [
          attachment({
            id: -42,
            status: 'uploading',
            filename: 'unfinished.png',
            local_path: undefined,
          }),
        ]
      )
    ).rejects.toThrow(
      i18n.t('workbench.attachment_preparation_unavailable', { filename: 'unfinished.png' })
    )
  })

  test('resolves a pending cloud upload into its remote ID before local-device transport', async () => {
    const { createPreparingAttachment, localRuntimeAttachments } =
      await import('@/lib/runtime-attachments')
    let finish!: (value: Attachment) => void
    const ready = new Promise<Attachment>(resolve => {
      finish = resolve
    })
    const pending = createPreparingAttachment(new File(['image'], 'pending.png'), ready)
    let delivered = false
    const preparing = prepareRuntimeAttachmentsForDevice(
      'local-device',
      [],
      [],
      localRuntimeAttachments([pending])
    ).then(result => {
      delivered = true
      return result
    })
    await Promise.resolve()
    expect(delivered).toBe(false)
    finish(attachment({ id: 42, local_path: undefined }))
    await expect(preparing).resolves.toEqual({ attachmentIds: [42], attachments: [] })
  })

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
