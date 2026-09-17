import { describe, expect, it, vi } from 'vitest'
import { createRuntimeConversationClient } from './runtime-conversation-client'
import {
  RUNTIME_TRANSCRIPT_ACK_TIMEOUT_MS,
  type CloudRuntimeIpcClient,
  type RuntimeEvent,
} from './runtime-ipc'
import type { RuntimeTranscriptResponse } from './runtime'

const address = {
  deviceId: 'remote-device',
  taskId: 'runtime-task-42',
  threadId: 'session-42',
  workspacePath: '/workspace',
  runtime: 'codex',
}
function setup() {
  let onEvent: ((event: RuntimeEvent) => void) | undefined
  const unsubscribe = vi.fn()
  const ipc: CloudRuntimeIpcClient = {
    request: vi.fn(),
    subscribe: vi.fn(async handler => {
      onEvent = handler
      return unsubscribe
    }),
    reconnect: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  }
  return {
    ipc,
    client: createRuntimeConversationClient(ipc),
    unsubscribe,
    emit: (event: RuntimeEvent) => onEvent?.(event),
  }
}

describe('runtime conversation client', () => {
  it('forwards scoped runtime failures to the comment watcher before turn projection', async () => {
    const { client, emit, unsubscribe } = setup()
    const onChatError = vi.fn()
    const cleanup = await client.subscribeChatStream({ scope: address, onChatError })
    emit({
      event: 'response.failed',
      payload: { ...address, taskId: 'other-task', data: { error: { message: 'Wrong session' } } },
    })
    expect(onChatError).not.toHaveBeenCalled()
    emit({
      event: 'response.failed',
      payload: { ...address, data: { error: { message: 'Model unavailable' } } },
    })
    expect(onChatError).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: address.deviceId,
        taskId: address.taskId,
        error: 'Model unavailable',
      })
    )
    cleanup()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
  it('preserves the full runtime address and pagination controls with the transcript deadline', async () => {
    const { client, ipc } = setup()
    const transcript: RuntimeTranscriptResponse = {
      workspacePath: '/workspace',
      runtime: 'codex',
      messages: [],
      turns: [],
    }
    vi.mocked(ipc.request).mockResolvedValue(transcript)
    const request = {
      ...address,
      limit: 50,
      afterCursor: 'offset:100',
      includeFullContent: true,
      refresh: true,
      navigationOnly: false,
    }
    expect(await client.getTranscript(request)).toBe(transcript)
    expect(ipc.request).toHaveBeenCalledWith(
      'runtime.tasks.transcript',
      request,
      address.deviceId,
      RUNTIME_TRANSCRIPT_ACK_TIMEOUT_MS
    )
  })
  it('rejects transcripts without canonical turns', async () => {
    const { client, ipc } = setup()
    vi.mocked(ipc.request).mockResolvedValue({ messages: [] })
    await expect(client.getTranscript(address)).rejects.toThrow('missing canonical turns')
  })
  it('rejects an incomplete runtime address before requesting a transcript', async () => {
    const { client, ipc } = setup()
    await expect(client.getTranscript({ ...address, taskId: '' })).rejects.toThrow(
      'deviceId and taskId'
    )
    expect(ipc.request).not.toHaveBeenCalled()
  })
  it('decodes live events using the native task handlers and ignores other sessions', async () => {
    const { client, emit, unsubscribe } = setup()
    const onMessageAction = vi.fn()
    const onAssistantStart = vi.fn()
    const cleanup = await client.subscribe(address, {
      onMessageAction,
      onAssistantStart,
    })
    emit({
      event: 'response.created',
      payload: { ...address, taskId: 'other-task', subtaskId: 'wrong-turn' },
    })
    expect(onMessageAction).not.toHaveBeenCalled()
    emit({
      event: 'response.created',
      payload: { data: { ...address, subtaskId: 'turn-1' } },
    })
    expect(onAssistantStart).toHaveBeenCalledWith('turn-1')
    emit({
      event: 'response.output_text.delta',
      payload: {
        ...address,
        subtaskId: 'turn-1',
        data: { delta: 'Hello', item_id: 'text-1' },
      },
    })
    expect(onMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'assistant_chunk',
        subtaskId: 'turn-1',
        content: 'Hello',
      })
    )
    cleanup()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
  it('reports lost history so the host can reload an authoritative snapshot', async () => {
    const { client, emit } = setup()
    const onHistoryInvalidated = vi.fn()
    await client.subscribe(address, {
      onMessageAction: vi.fn(),
      onHistoryInvalidated,
    })
    emit({ event: 'executor.event_lagged', payload: { skipped: 3 } })
    emit({
      event: 'executor.runtime_replaced',
      payload: { runtimeInstanceId: 'new' },
    })
    expect(onHistoryInvalidated).toHaveBeenCalledTimes(2)
  })
  it('propagates subscription failures to the host', async () => {
    const { client, ipc } = setup()
    vi.mocked(ipc.subscribe).mockRejectedValue(new Error('Disconnected'))
    await expect(client.subscribe(address, { onMessageAction: vi.fn() })).rejects.toThrow(
      'Disconnected'
    )
  })
  it('stops the addressed runtime and surfaces a rejected stop request', async () => {
    const { client, ipc } = setup()
    vi.mocked(ipc.request).mockResolvedValue({
      accepted: false,
      error: 'Task unavailable',
    })
    await expect(client.cancel(address)).rejects.toThrow('Task unavailable')
    expect(ipc.request).toHaveBeenCalledWith('runtime.tasks.cancel', address, address.deviceId)
  })
  it('accepts successful cancellation and disposes the owned transport', async () => {
    const { client, ipc } = setup()
    vi.mocked(ipc.request).mockResolvedValue({ accepted: true })
    await expect(client.cancel(address)).resolves.toBeUndefined()
    client.dispose()
    expect(ipc.dispose).toHaveBeenCalledOnce()
  })
})
