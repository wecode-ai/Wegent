import React, { createRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatReducer } from '@/domain/chatReducer'
import { pendingMobileUserInput, userInputResponse } from '@/domain/requestUserInput'
import type { ChatMessage, RequestUserInputPayload, RuntimeTaskAddress } from '@/types/runtime'
import type { RuntimeApi } from '@/services/runtimeApi'
import { useMobileUserInput } from './useMobileUserInput'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('expo-crypto', () => ({ randomUUID: () => 'reply-id' }))

describe('mobile user-input delivery matches PC cloud-device routing', () => {
  let renderer: ReactTestRenderer
  let hook: ReturnType<typeof useMobileUserInput>
  let messages: ChatMessage[]
  let payload: RequestUserInputPayload
  let running: boolean
  const currentAddress = createRef<RuntimeTaskAddress | null>()
  const address = { deviceId: 'device-1', taskId: 'task-1' }
  const api = {
    respondToUserInput: vi.fn(),
    guideTask: vi.fn(),
    sendMessage: vi.fn(),
    cancelTask: vi.fn(),
  }
  const dispatch = vi.fn((target, action) => {
    messages = chatReducer(messages, action)
  })
  const onTurnStarted = vi.fn()
  function Harness() {
    hook = useMobileUserInput({
      api: api as unknown as RuntimeApi,
      currentAddress,
      readMessages: () => messages,
      dispatch,
      isRunning: () => running,
      modelSelection: { modelName: 'gpt-6', modelType: 'public', options: {} },
      onTurnStarted,
    })
    return null
  }
  beforeEach(async () => {
    vi.clearAllMocks()
    currentAddress.current = address
    running = true
    payload = {
      kind: 'request_user_input',
      requestId: 0,
      interactionScope: 'turn-1',
      questions: [{ id: 'choice', question: 'Pick one', options: [{ label: 'One' }] }],
    }
    messages = [
      {
        id: 'assistant',
        subtaskId: 'turn-1',
        role: 'assistant',
        status: 'streaming',
        content: '',
        createdAt: 1,
        blocks: [
          {
            id: 'question',
            subtaskId: 'turn-1',
            type: 'tool',
            toolName: 'request_user_input',
            status: 'pending',
            createdAt: 1,
            renderPayload: payload,
          },
        ],
      },
    ]
    api.respondToUserInput.mockResolvedValue({ accepted: true })
    api.guideTask.mockResolvedValue({ accepted: true })
    api.sendMessage.mockResolvedValue({ accepted: true })
    api.cancelTask.mockResolvedValue({ accepted: true })
    await act(() => {
      renderer = create(<Harness />)
    })
  })
  afterEach(async () => {
    await act(() => renderer.unmount())
  })

  it('answers a blocking request structurally without sending a normal user message', async () => {
    const response = userInputResponse(payload, { choice: 'One' })
    await expect(hook.respondToUserInput(response)).resolves.toBe(true)
    expect(api.respondToUserInput).toHaveBeenCalledWith(address, response)
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(api.guideTask).not.toHaveBeenCalled()
    expect(pendingMobileUserInput(messages).size).toBe(0)
  })

  it.each([true, false])(
    'routes async answers through guidance only while running=%s',
    async busy => {
      payload.delivery = 'async'
      running = busy
      await hook.respondToUserInput(userInputResponse(payload, { choice: 'One' }))
      expect(api.respondToUserInput).not.toHaveBeenCalled()
      if (busy) expect(api.guideTask).toHaveBeenCalledWith(address, 'One', 'reply-id')
      else
        expect(api.sendMessage).toHaveBeenCalledWith(
          address,
          'One',
          'reply-id',
          expect.objectContaining({ modelName: 'gpt-6' })
        )
    }
  )

  it('retains failed answers for an explicit retry', async () => {
    const response = userInputResponse(payload, { choice: 'One' })
    api.respondToUserInput.mockResolvedValueOnce({ accepted: false, error: 'Try again' })
    await expect(hook.respondToUserInput(response)).rejects.toThrow('Try again')
    expect(pendingMobileUserInput(messages).size).toBe(1)
    await expect(hook.respondToUserInput(response)).resolves.toBe(true)
    expect(api.respondToUserInput).toHaveBeenCalledTimes(2)
  })

  it.each([
    { accepted: false, success: true },
    { accepted: true, success: false },
  ])('preserves async questions when guidance explicitly rejects with %j', async result => {
    payload.delivery = 'async'
    api.guideTask.mockResolvedValue(result)
    await expect(
      hook.respondToUserInput(userInputResponse(payload, { choice: 'One' }))
    ).rejects.toThrow('未被执行器接受')
    expect(pendingMobileUserInput(messages).size).toBe(1)
  })

  it('accepts guidance without explicit rejection flags, matching PC', async () => {
    payload.delivery = 'async'
    api.guideTask.mockResolvedValue({})
    await expect(
      hook.respondToUserInput(userInputResponse(payload, { choice: 'One' }))
    ).resolves.toBe(true)
    expect(pendingMobileUserInput(messages).size).toBe(0)
  })

  it('coalesces repeated clicks and applies a late reply only to its captured device task', async () => {
    let resolve!: (result: { accepted: boolean }) => void
    api.respondToUserInput.mockImplementation(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    const response = userInputResponse(payload, { choice: 'One' })
    const first = hook.respondToUserInput(response)
    await expect(hook.respondToUserInput(response)).resolves.toBe(false)
    currentAddress.current = { deviceId: 'device-2', taskId: 'task-1' }
    resolve({ accepted: true })
    await first
    expect(dispatch).toHaveBeenCalledWith(address, { type: 'user-input-response', response })
    expect(api.respondToUserInput).toHaveBeenCalledOnce()
  })

  it('skips a question by cancelling its task only after acceptance', async () => {
    api.cancelTask.mockResolvedValueOnce({ accepted: false, error: 'Unavailable' })
    await expect(hook.skipUserInput(payload)).rejects.toThrow('Unavailable')
    expect(pendingMobileUserInput(messages).size).toBe(1)
    await expect(hook.skipUserInput(payload)).resolves.toBe(true)
    expect(api.cancelTask).toHaveBeenCalledWith(address)
    expect(pendingMobileUserInput(messages).size).toBe(0)
  })

  it('declines an MCP form with empty structured answers rather than cancelling the task', async () => {
    payload.interactionKind = 'mcp_form'
    await hook.skipUserInput(payload)
    expect(api.respondToUserInput).toHaveBeenCalledWith(
      address,
      expect.objectContaining({ answers: {} })
    )
    expect(api.cancelTask).not.toHaveBeenCalled()
  })

  it('rejects an expired request before any transport call', async () => {
    payload.expiresAtUnixMs = 1
    await expect(
      hook.respondToUserInput(userInputResponse(payload, { choice: 'One' }))
    ).rejects.toThrow('不再等待')
    expect(api.respondToUserInput).not.toHaveBeenCalled()
  })
})
