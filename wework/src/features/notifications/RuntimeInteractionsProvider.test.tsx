// Register provider mocks before importing modules that consume them.
import { context, harness, view } from './runtimeInteractionsProvider.fixtures'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { RuntimeInteractionsProvider } from './RuntimeInteractionsProvider'
import { useRuntimeInteractions } from './RuntimeInteractionsContext'

import {
  ConversationTranslationProvider,
  RequestUserInputCard,
} from '@wegent/collaboration/conversation'
import { canReplyToInteraction } from './runtimeInteractions'

import {
  interactionQuestion,
  interactionTask,
  interactionTranscript,
} from './runtimeInteractions.fixtures'
describe('unified human response', () => {
  it('never writes a stale shared draft into the answer input during IME composition', async () => {
    function Answer() {
      const interactions = useRuntimeInteractions()
      if (!interactions) return null
      return (
        <ConversationTranslationProvider translate={key => key}>
          <RequestUserInputCard
            payload={{ questions: [{ id: 'details', question: 'Details' }] }}
            draftAnswers={{ details: interactions.drafts.ime ?? '' }}
            onDraftAnswersChange={answers => interactions.setDraft('ime', answers.details)}
          />
        </ConversationTranslationProvider>
      )
    }
    render(
      <RuntimeInteractionsProvider accountKey="ime">
        <Answer />
      </RuntimeInteractionsProvider>
    )
    const input = (await screen.findByTestId(
      'request-user-input-custom-details'
    )) as HTMLElement & { value: string }
    const value = Object.getOwnPropertyDescriptor(input, 'value')!
    const writes: string[] = []
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() {
        return value.get!.call(this)
      },
      set(text: string) {
        writes.push(text)
        value.set!.call(this, text)
      },
    })
    input.focus()
    fireEvent.compositionStart(input)
    act(() => value.set!.call(input, 'ni'))
    fireEvent.input(input, { isComposing: true })
    expect(writes).not.toContain('')
    expect(input).toHaveValue('ni')
    expect(input).toHaveFocus()
    act(() => value.set!.call(input, '你好'))
    fireEvent.input(input, { isComposing: true })
    fireEvent.compositionEnd(input, { data: '你好' })
    expect(writes).not.toContain('ni')
    expect(input).toHaveValue('你好')
  })

  it('locks and revalidates an entity-owned send, then prevents a duplicate native submission', async () => {
    view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const item = context!.pending[0]
    const nativeSend = vi.fn(async () => true)
    await act(async () => {
      expect(await context!.respond(item, 'keep', { send: nativeSend })).toBe(true)
      expect(await context!.respond(item, 'keep', { send: nativeSend })).toBe(false)
    })
    expect(nativeSend).toHaveBeenCalledOnce()
    expect(harness.send).not.toHaveBeenCalled()
    expect(harness.guide).not.toHaveBeenCalled()
    expect(context!.history).toHaveLength(1)
  })

  it('does not call an entity-owned sender when its request is no longer live', async () => {
    view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const item = context!.pending[0]
    harness.transcript.mockResolvedValue({ ...interactionTranscript(), messages: [] })
    const nativeSend = vi.fn(async () => true)
    await act(async () => {
      expect(await context!.respond(item, 'keep', { send: nativeSend })).toBe(false)
    })
    expect(nativeSend).not.toHaveBeenCalled()
    expect(context!.history).toHaveLength(0)
  })
  it.each([true, false])(
    'serializes replies across provider instances and permits retry only after failure (accepted=%s)',
    async accepted => {
      harness.list.mockResolvedValue({
        projects: [],
        chats: [{ ...interactionTask.workspace, tasks: [interactionTask.task] }],
        totalTasks: 1,
      })
      view()
      await waitFor(() => expect(context!.pending).toHaveLength(1))
      const first = context!
      view()
      await waitFor(() => expect(context).not.toBe(first))
      await waitFor(() => expect(context!.pending[0]?.cached).not.toBe(true))
      const second = context!
      let finish!: (result: { accepted: boolean }) => void
      harness.send.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve
          })
      )
      let firstReply!: Promise<boolean>, secondReply!: Promise<boolean>
      act(() => {
        firstReply = first.respond(first.pending[0], 'first answer')
      })
      await waitFor(() => expect(harness.send).toHaveBeenCalledTimes(1))
      act(() => {
        secondReply = second.respond(second.pending[0], 'second answer')
      })
      await act(async () => {
        await Promise.resolve()
      })
      expect(harness.send).toHaveBeenCalledTimes(1)
      await act(async () => {
        finish({ accepted })
        expect(await firstReply).toBe(accepted)
        expect(await secondReply).toBe(!accepted)
      })
      expect(harness.send).toHaveBeenCalledTimes(accepted ? 1 : 2)
    }
  )

  it('rejects a stale response without discarding its unsent text after its acceptance marker has been cleaned', async () => {
    view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const item = context!.pending[0]
    await act(async () => {
      expect(await context!.respond(item, 'first answer')).toBe(true)
    })
    const marker = `wework.interactions:test:1:accepted:${item.id}`
    expect(localStorage.getItem(marker)).toBe('true')
    localStorage.removeItem(marker)
    act(() => context!.setDraft(item.id, 'stale second answer'))
    await act(async () => {
      expect(await context!.respond(item, 'stale second answer')).toBe(false)
    })
    expect(harness.send).toHaveBeenCalledTimes(1)
    expect(context!.errors).toEqual({})
    expect(context!.drafts[item.id]).toBe('stale second answer')
    expect(context!.replyDrafts).toEqual([expect.objectContaining({ text: 'stale second answer' })])
    expect(screen.getByTestId('interaction-unsent-text')).toHaveValue('stale second answer')
  })

  it('does not replay a failed native answer or overwrite its draft after renderer reload', async () => {
    harness.desktop = true
    harness.send.mockResolvedValue({ accepted: false, error: 'rejected' })
    let replies = [{ id: 'native-reload', interactionId: '', text: 'original native text' }]
    let failedAcknowledgement = false
    harness.host.mockImplementation(async (command: string) => {
      if (command === 'notification.pendingReplies') return replies[0]?.interactionId ? replies : []
      if (command === 'notification.acknowledgeReply') {
        if (!failedAcknowledgement) {
          failedAcknowledgement = true
          throw new Error('host unavailable')
        }
        replies = []
      }
    })
    const first = view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const id = context!.pending[0].id
    replies[0].interactionId = id
    act(() => harness.hostListeners.forEach(listener => listener({ type: 'notification-reply' })))
    await waitFor(() => expect(failedAcknowledgement).toBe(true))
    act(() => context!.setDraft(id, 'edited before reload'))
    await waitFor(() =>
      expect(localStorage.getItem('wework.interactions:test:1:drafts')).toContain(
        'edited before reload'
      )
    )
    first.unmount()
    view()
    await waitFor(() => expect(replies).toEqual([]))
    expect(harness.send).toHaveBeenCalledTimes(1)
    expect(context!.drafts[id]).toBe('edited before reload')
    expect(context!.history).toEqual([])
  })

  it('does not dispatch an old-account answer after its attachment upload finishes', async () => {
    const rendered = view()
    let finish!: (value: { id: number; filename: string; status: 'ready' }) => void
    const upload = vi.fn(
      () =>
        new Promise<{ id: number; filename: string; status: 'ready' }>(resolve => {
          finish = resolve
        })
    )
    const source = {
      ...rendered.taskSource,
      devices: [{ device_id: 'device', device_type: 'cloud' }] as NonNullable<
        typeof rendered.taskSource.devices
      >,
      services: {
        ...rendered.taskSource.services!,
        attachmentApi: { uploadLocalAttachmentToCloud: upload },
      } as typeof rendered.taskSource.services,
    }
    rendered.rerenderSource(source)
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const item = context!.pending[0]
    let reply!: Promise<boolean>
    act(() => {
      reply = context!.respond(item, '', {
        response: {
          itemId: item.payload.itemId,
          answers: {
            compatibility: {
              answers: [''],
              attachments: [
                { id: -1, filename: 'brief.txt', local_path: '/tmp/brief.txt', status: 'ready' },
              ],
            },
          },
        },
      })
    })
    await waitFor(() => expect(upload).toHaveBeenCalledOnce())
    rendered.rerenderSource({ ...source, items: [] }, 'test:2')
    await act(async () => {
      finish({ id: 42, filename: 'brief.txt', status: 'ready' })
      expect(await reply).toBe(false)
    })
    expect(harness.send).not.toHaveBeenCalled()
    expect(context!.drafts).toEqual({})
    expect(context!.history).toEqual([])
  })

  it('keeps an accepted old-account reply out of the new account state', async () => {
    let accept!: (result: { accepted: boolean }) => void
    harness.send.mockImplementation(
      () =>
        new Promise(resolve => {
          accept = resolve
        })
    )
    const rendered = view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    let reply!: Promise<boolean>
    act(() => {
      reply = context!.respond(context!.pending[0], 'keep')
    })
    await waitFor(() => expect(harness.send).toHaveBeenCalledTimes(1))
    rendered.rerenderSource({ ...rendered.taskSource, items: [] }, 'test:2')
    await act(async () => {
      accept({ accepted: true })
      expect(await reply).toBe(true)
    })
    expect(context!.history).toEqual([])
    expect(context!.drafts).toEqual({})
    expect(context!.busy.size).toBe(0)
    expect(context!.errors).toEqual({})
    expect(context!.notice).toBeNull()
  })

  it('routes a running async answer through attachment preparation before guidance', async () => {
    const task = {
      ...interactionTask,
      lifecycle: { turn: { active: true } },
    } as typeof interactionTask
    view(interactionQuestion, task, false, undefined, true, true)
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    await act(async () => {
      expect(await context!.respond(context!.pending[0], 'keep')).toBe(true)
    })
    expect(harness.send).toHaveBeenCalledWith(
      expect.objectContaining({
        address: interactionTask.address,
        message: 'keep',
        requestUserInputResponse: expect.objectContaining({ delivery: 'async' }),
      })
    )
    expect(harness.guide).not.toHaveBeenCalled()
    expect(context!.pending).toHaveLength(0)
  })

  it('retains non-image attachments and the pending reminder after a rejected running answer', async () => {
    view(interactionQuestion, {
      ...interactionTask,
      lifecycle: { turn: { active: true } },
    } as typeof interactionTask)
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const item = context!.pending[0]
    const file = {
      id: 42,
      filename: 'brief.txt',
      mime_type: 'text/plain',
      status: 'ready' as const,
    }
    const response = {
      itemId: item.payload.itemId,
      requestId: item.payload.requestId,
      answers: { [item.payload.questions![0].id!]: { answers: [''], attachments: [file] } },
    }
    harness.send.mockResolvedValueOnce({ accepted: false, error: 'Offline' })
    await act(async () => expect(await context!.respond(item, '', { response })).toBe(false))
    expect(context!.pending).toHaveLength(1)
    await act(async () => expect(await context!.respond(item, '', { response })).toBe(true))
    expect(harness.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        address: interactionTask.address,
        attachments: [file],
        requestUserInputResponse: { ...response, delivery: 'async' },
      })
    )
    expect(harness.guide).not.toHaveBeenCalled()
    expect(context!.pending).toHaveLength(0)
  })

  it.each([false, true])(
    'lets the owning executor restore its saved model for an async response (handle only: %s)',
    async handleOnly => {
      const modelSelection = {
        modelName: 'team-review-model',
        modelType: 'user' as const,
        options: { reasoning: 'high', weworkCloudModelNamespace: 'team' },
      }
      const task = {
        ...interactionTask,
        task: {
          ...interactionTask.task,
          ...(handleOnly ? { runtimeHandle: { modelSelection } } : { modelSelection }),
        },
      }
      view(interactionQuestion, task)
      await waitFor(() => expect(context!.pending).toHaveLength(1))
      await act(async () => {
        expect(await context!.respond(context!.pending[0], 'keep')).toBe(true)
      })
      expect(harness.send).toHaveBeenCalledWith(
        expect.objectContaining({
          address: interactionTask.address,
          requestUserInputResponse: expect.objectContaining({ delivery: 'async' }),
        })
      )
      expect(harness.send.mock.calls[0][0]).not.toHaveProperty('modelId')
      expect(harness.send.mock.calls[0][0]).not.toHaveProperty('executionRequest')
    }
  )

  it('answers a synchronous request with its identity instead of creating a user turn', async () => {
    view({ ...interactionQuestion, delivery: undefined, requestId: 22, interactionScope: 'turn-1' })
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    await act(async () => {
      await context!.respond(context!.pending[0], 'keep')
    })
    expect(harness.send).toHaveBeenCalledWith(
      expect.objectContaining({
        requestUserInputResponse: expect.objectContaining({
          requestId: 22,
          interactionScope: 'turn-1',
          answers: { compatibility: { answers: ['keep'] } },
        }),
      })
    )
  })

  it('never turns an execution approval into an ordinary reply', async () => {
    view({ ...interactionQuestion, approvalKind: 'command' })
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    await act(async () => {
      expect(await context!.respond(context!.pending[0], 'Allow')).toBe(false)
    })
    expect(harness.send).not.toHaveBeenCalled()
    expect(screen.getByTestId('original-notification-entity')).toBeInTheDocument()
    expect(canReplyToInteraction(context!.pending[0])).toBe(false)
  })

  it('revalidates a request already answered in its original conversation', async () => {
    view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    harness.transcript.mockResolvedValue(
      interactionTranscript({ ...interactionQuestion, interactionStatus: 'answered' })
    )
    await act(async () => {
      expect(await context!.respond(context!.pending[0], 'keep')).toBe(false)
    })
    expect(harness.send).not.toHaveBeenCalled()
  })
})
