// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeConversationSession } from '@wegent/chat-core/runtime-conversation-session'
import type { RuntimeConversationClient } from '@wegent/chat-core'
import type { RuntimeTranscriptResponse } from '@wegent/chat-core/runtime'
import { RequestUserInputCard } from '../conversation/RequestUserInputCard'
import { ConversationTranslationProvider } from '../conversation/ConversationTranslation'
import { createCollaborationTranslator } from '../i18n'
import { useBrowserConversationActions } from './useBrowserConversationActions'

const address = { deviceId: 'device-1', taskId: 'task-1' }
const translate = createCollaborationTranslator('zh-CN')
const payload = {
  kind: 'request_user_input',
  requestId: 'question-1',
  itemId: 'tool-1',
  questions: [
    { id: 'directory', question: '工作目录？', options: [{ label: '当前目录', value: '/repo' }] },
  ],
}

describe('browser runtime question actions', () => {
  let root: Root
  let container: HTMLDivElement
  let session: ReturnType<typeof createRuntimeConversationSession>
  let actions: ReturnType<typeof useBrowserConversationActions>
  let runtime: Parameters<typeof useBrowserConversationActions>[0]
  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    runtime = {
      work: { sendRuntimeMessage: vi.fn().mockResolvedValue({ accepted: true }) },
      cancel: vi.fn().mockResolvedValue(undefined),
    }
    const transcript: RuntimeTranscriptResponse = {
      runtime: 'codex',
      workspacePath: '/repo',
      running: true,
      messages: [],
      turns: [
        {
          id: 'failed-turn',
          status: 'failed',
          items: [
            {
              id: 'failed-text',
              type: 'assistant_text',
              content: 'Failed execution',
              createdAt: '2026-09-17T00:00:00Z',
            },
          ],
        },
        {
          id: 'turn-1',
          status: 'streaming',
          items: [
            {
              id: 'tool-1',
              type: 'block',
              block: {
                id: 'tool-1',
                type: 'tool',
                toolName: 'request_user_input',
                status: 'pending',
                renderPayload: payload,
              },
            },
          ],
        },
      ],
    }
    const client: RuntimeConversationClient = {
      getTranscript: vi.fn().mockResolvedValue(transcript),
      subscribe: vi.fn().mockResolvedValue(() => {}),
      cancel: runtime.cancel,
      dispose: vi.fn(),
    }
    session = createRuntimeConversationSession(client, address)
    session.start()
    await session.reload()
    function Harness() {
      actions = useBrowserConversationActions(runtime, address, session, translate, () => ({
        address,
        modelId: 'owned-model',
        modelType: 'user',
        modelOptions: { weworkCloudModelNamespace: 'team', weworkCloudModelResourceUserId: '42' },
        cloudProjectId: 'project-1',
      }))
      return (
        <ConversationTranslationProvider translate={translate}>
          {actions.error && <div role="alert">{actions.error}</div>}
          <RequestUserInputCard
            payload={payload}
            onSubmit={actions.onRequestUserInputSubmit}
            onIgnore={() => void actions.onRequestUserInputIgnore(payload)}
          />
        </ConversationTranslationProvider>
      )
    }
    await act(async () => root.render(<Harness />))
  })
  afterEach(() => {
    act(() => root.unmount())
    session.stop()
    container.remove()
  })
  function button(id: string) {
    return container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!
  }
  function answeredBlock() {
    const item = session.getSnapshot().turns.find(turn => turn.id === 'turn-1')!.items[0]
    if (item.type !== 'block') throw new Error('Question block missing')
    return item.block
  }
  it('sends an answer to its original session and records acceptance in canonical turns', async () => {
    await act(async () => button('request-user-input-submit-button').click())
    expect(runtime.work.sendRuntimeMessage).toHaveBeenCalledWith({
      address,
      message: '/repo',
      requestUserInputResponse: {
        requestId: 'question-1',
        itemId: 'tool-1',
        answers: { directory: { answers: ['/repo'] } },
      },
    })
    expect(answeredBlock()).toMatchObject({
      status: 'done',
      renderPayload: { response: { requestId: 'question-1' } },
    })
    expect(button('request-user-input-submit-button').disabled).toBe(true)
    await session.reload()
    expect(answeredBlock()).toMatchObject({
      status: 'done',
      renderPayload: { response: { requestId: 'question-1' } },
    })
  })
  it('keeps the answer editable and the question pending when runtime rejects it', async () => {
    vi.mocked(runtime.work.sendRuntimeMessage).mockResolvedValueOnce({
      accepted: false,
      taskId: address.taskId,
      error: 'Question expired',
    })
    await act(async () => button('request-user-input-submit-button').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Question expired')
    expect(answeredBlock().status).toBe('pending')
    expect(button('request-user-input-submit-button').disabled).toBe(false)
    await act(async () => button('request-user-input-submit-button').click())
    expect(answeredBlock().status).toBe('done')
  })
  it('hides an ignored question only after the stop request succeeds', async () => {
    vi.mocked(runtime.cancel).mockRejectedValueOnce(new Error('Device offline'))
    await act(async () => button('request-user-input-ignore-button').click())
    expect(actions.hiddenRequestUserInputIds.size).toBe(0)
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Device offline')
    await act(async () => button('request-user-input-ignore-button').click())
    expect(runtime.cancel).toHaveBeenLastCalledWith(address)
    expect(actions.hiddenRequestUserInputIds.has('request:question-1')).toBe(true)
  })
  it('prevents an answer and a simultaneous ignore from racing each other', async () => {
    let accept!: (value: { accepted: boolean; taskId: string }) => void
    vi.mocked(runtime.work.sendRuntimeMessage).mockReturnValueOnce(
      new Promise(resolve => {
        accept = resolve
      })
    )
    act(() => button('request-user-input-submit-button').click())
    await act(async () => button('request-user-input-ignore-button').click())
    expect(runtime.cancel).not.toHaveBeenCalled()
    await act(async () => accept({ accepted: true, taskId: address.taskId }))
    expect(answeredBlock().status).toBe('done')
  })
  it('retries with the selected destination model and rolls back a rejected optimistic message', async () => {
    const failed = session.getSnapshot().messages.find(message => message.status === 'failed')!
    const original = session.getSnapshot().messages
    vi.mocked(runtime.work.sendRuntimeMessage).mockResolvedValueOnce({
      accepted: false,
      taskId: address.taskId,
      error: 'Device offline',
    })
    await act(async () => {
      expect(await actions.onRetryFailedMessage!(failed)).toBe(false)
    })
    expect(actions.error).toBe('Device offline')
    expect(session.getSnapshot().messages).toEqual(original)
    await act(async () => {
      expect(await actions.onRetryFailedMessage!(failed)).toBe(true)
    })
    expect(session.getSnapshot().messages.at(-1)).toMatchObject({
      role: 'user',
      content: '继续',
    })
    expect(runtime.work.sendRuntimeMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        address,
        modelId: 'owned-model',
        modelType: 'user',
        modelOptions: { weworkCloudModelNamespace: 'team', weworkCloudModelResourceUserId: '42' },
        cloudProjectId: 'project-1',
      })
    )
  })
  it('ignores duplicate retries and validates against the current transcript', async () => {
    const failed = session.getSnapshot().messages.find(message => message.status === 'failed')!
    let finish!: (value: { accepted: boolean; taskId: string }) => void
    vi.mocked(runtime.work.sendRuntimeMessage).mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve
      })
    )
    let pending!: Promise<boolean>
    act(() => {
      pending = actions.onRetryFailedMessage!(failed)
    })
    await act(async () => {
      expect(await actions.onRetryFailedMessage!(failed)).toBe(false)
    })
    expect(runtime.work.sendRuntimeMessage).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish({ accepted: true, taskId: address.taskId })
      await pending
    })
    await act(async () => {
      expect(await actions.onRetryFailedMessage!({ ...failed, id: 'missing' })).toBe(false)
    })
    expect(runtime.work.sendRuntimeMessage).toHaveBeenCalledTimes(1)
    expect(actions.error).toBe('未找到可重试的失败消息')
  })
})
