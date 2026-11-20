import '@/i18n'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import type { Attachment, RequestUserInputPayload } from '@/types/api'
import { setComposerValue } from '@/test/composer'
import {
  QuestionDiscussionStoreContext,
  QuestionDiscussionContext,
  type QuestionDiscussionStore,
  type QuestionDiscussionSession,
} from '@/features/notifications/questionDiscussion'
import { RequestUserInputCard } from './RequestUserInputCard'

const file: Attachment = {
  id: -1,
  filename: 'brief.txt',
  file_extension: '.txt',
  mime_type: 'text/plain',
  status: 'ready',
  local_path: '/tmp/brief.txt',
}
const payload: RequestUserInputPayload = {
  itemId: 'question',
  questions: [{ id: 'details', question: 'Details?', is_other: true }],
}
const input = (id = 'details') => screen.getByTestId(`request-user-input-custom-${id}`)
const submit = () => screen.getByTestId('request-user-input-submit-button')
const paste = (id = 'details') =>
  fireEvent.paste(input(id), {
    clipboardData: {
      files: [new File(['brief'], 'brief.txt')],
      types: ['Files'],
      getData: () => '',
    },
  })

describe('question answer recovery', () => {
  test('can abandon a failed native transfer and submit the preserved text', async () => {
    const send = vi.fn().mockResolvedValue(false)
    render(
      <RequestUserInputCard
        payload={payload}
        onSubmit={send}
        composerServices={{
          transferServices: {
            hasPathTransfer: () => true,
            resolveTransfer: async () => {
              throw new Error('Clipboard unavailable')
            },
          },
        }}
      />
    )
    setComposerValue(input(), 'Keep this answer')
    paste()
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Clipboard unavailable')
    )
    expect(submit()).toBeDisabled()
    fireEvent.click(screen.getByTestId('request-user-input-custom-details-dismiss-transfer-error'))
    await waitFor(() => expect(submit()).toBeEnabled())
    fireEvent.click(submit())
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          answers: { details: { answers: ['Keep this answer'] } },
        })
      )
    )
  })

  test('can dismiss an upload error without a custom attachment renderer', async () => {
    render(
      <RequestUserInputCard
        payload={payload}
        onSubmit={vi.fn()}
        composerServices={{
          uploadAttachment: async () => {
            throw new Error('Disk full')
          },
        }}
      />
    )
    paste()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Disk full'))
    expect(submit()).toBeDisabled()
    fireEvent.click(screen.getByTestId('request-user-input-dismiss-file-error-details-brief.txt'))
    await waitFor(() => expect(submit()).toBeEnabled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('cannot clear a transfer error while another clipboard transfer is still pending', async () => {
    let reject!: (error: Error) => void
    let finish!: (value: { referenceEntries: []; attachmentFiles: [] }) => void
    const resolveTransfer = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve
          })
      )
    render(
      <RequestUserInputCard
        payload={payload}
        onSubmit={vi.fn()}
        composerServices={{
          transferServices: { hasPathTransfer: () => true, resolveTransfer },
        }}
      />
    )
    paste()
    paste()
    await act(async () => reject(new Error('Unreadable file')))
    const dismiss = screen.getByTestId('request-user-input-custom-details-dismiss-transfer-error')
    expect(dismiss).toBeDisabled()
    expect(submit()).toBeDisabled()
    await act(async () => finish({ referenceEntries: [], attachmentFiles: [] }))
    expect(dismiss).toBeEnabled()
    expect(submit()).toBeDisabled()
    fireEvent.click(dismiss)
    await waitFor(() => expect(submit()).toBeEnabled())
  })

  test('restores non-default preset selections after remount without replacing custom text', async () => {
    const send = vi.fn().mockResolvedValue(false)
    const question = {
      ...payload,
      questions: [
        {
          id: 'details',
          question: 'Details?',
          is_other: true,
          options: [{ label: 'A' }, { label: 'B' }],
        },
        { id: 'scope', question: 'Scope?', options: [{ label: 'C' }, { label: 'D' }] },
      ],
    }
    function Harness() {
      const [show, setShow] = useState(true)
      const [sessions, setSessions] = useState<Record<string, QuestionDiscussionSession>>({})
      const store: QuestionDiscussionStore = {
        accountKey: 'test',
        sessions,
        panelRequest: null,
        update: (key, update) =>
          setSessions(current => ({ ...current, [key]: update(current[key]) })),
        requestPanel: vi.fn(),
        consumePanelRequest: vi.fn(),
        create: vi.fn(),
      }
      return (
        <QuestionDiscussionContext.Provider value={{ open: vi.fn() }}>
          <QuestionDiscussionStoreContext.Provider value={store}>
            <button onClick={() => setShow(value => !value)}>Toggle</button>
            {show && (
              <RequestUserInputCard
                payload={question}
                onSubmit={send}
                source={{ deviceId: 'device', taskId: 'task' }}
              />
            )}
          </QuestionDiscussionStoreContext.Provider>
        </QuestionDiscussionContext.Provider>
      )
    }
    render(<Harness />)
    setComposerValue(input(), 'Custom draft')
    fireEvent.click(screen.getByTestId('request-user-input-option-details-1'))
    fireEvent.click(screen.getByTestId('request-user-input-option-scope-1'))
    fireEvent.click(screen.getByText('Toggle'))
    fireEvent.click(screen.getByText('Toggle'))
    expect(input()).toHaveValue('Custom draft')
    fireEvent.click(submit())
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          answers: { details: { answers: ['B'] }, scope: { answers: ['D'] } },
        })
      )
    )
  })

  test('shares option and attachment edits between retained cards for one request', async () => {
    const send = vi.fn().mockResolvedValue(false)
    let finishSlow!: (attachment: Attachment) => void
    let nextFileId = 0
    const question = {
      ...payload,
      questions: [
        { id: 'details', question: 'Details?', options: [{ label: 'A' }, { label: 'B' }] },
        { id: 'scope', question: 'Scope?', is_other: true },
      ],
    }
    function Harness() {
      const [sessions, setSessions] = useState<Record<string, QuestionDiscussionSession>>({})
      const store: QuestionDiscussionStore = {
        accountKey: 'test',
        sessions,
        panelRequest: null,
        update: (key, update) =>
          setSessions(current => ({ ...current, [key]: update(current[key]) })),
        requestPanel: vi.fn(),
        consumePanelRequest: vi.fn(),
        create: vi.fn(),
      }
      const composerServices = {
        uploadAttachment: async (input: File) => {
          if (input.name === 'slow.txt')
            return new Promise<Attachment>(resolve => {
              finishSlow = resolve
            })
          return {
            ...file,
            id: ++nextFileId,
            filename: input.name,
            local_path: `/tmp/${input.name}`,
          }
        },
        renderAttachments: ({
          state,
          remove,
        }: {
          state: { attachments: Attachment[] }
          remove(id: number): void
        }) =>
          state.attachments.map(item => (
            <button key={item.id} onClick={() => remove(item.id)}>
              Remove {item.filename}
            </button>
          )),
      }
      return (
        <QuestionDiscussionContext.Provider value={{ open: vi.fn() }}>
          <QuestionDiscussionStoreContext.Provider value={store}>
            <RequestUserInputCard
              payload={question}
              onSubmit={vi.fn()}
              source={{ deviceId: 'device', taskId: 'task' }}
              composerServices={composerServices}
            />
            <RequestUserInputCard
              payload={question}
              onSubmit={send}
              source={{ deviceId: 'device', taskId: 'task' }}
              composerServices={composerServices}
            />
          </QuestionDiscussionStoreContext.Provider>
        </QuestionDiscussionContext.Provider>
      )
    }
    render(<Harness />)
    const [editor, retained] = screen.getAllByTestId('request-user-input-card')
    setComposerValue(
      within(retained).getByTestId('request-user-input-custom-scope'),
      'Retained text'
    )
    fireEvent.click(within(editor).getByTestId('request-user-input-option-details-1'))
    const senderInput = within(editor).getByTestId('request-user-input-custom-scope')
    fireEvent.paste(senderInput, {
      clipboardData: {
        files: [new File(['brief'], 'brief.txt')],
        types: ['Files'],
        getData: () => '',
      },
    })
    await waitFor(() => expect(within(retained).getByText('Remove brief.txt')).toBeVisible())
    expect(within(editor).getByTestId('request-user-input-custom-scope')).toBe(senderInput)
    expect(within(retained).getByTestId('request-user-input-custom-scope')).toHaveValue(
      'Retained text'
    )
    fireEvent.click(within(retained).getByTestId('request-user-input-submit-button'))
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          answers: {
            details: { answers: ['B'] },
            scope: {
              answers: ['Retained text'],
              attachments: [
                expect.objectContaining({ filename: 'brief.txt', text_content: 'brief' }),
              ],
            },
          },
        })
      )
    )
    send.mockClear()
    const retainedInput = within(retained).getByTestId('request-user-input-custom-scope')
    const pasteFile = (target: Element, filename: string) =>
      fireEvent.paste(target, {
        clipboardData: {
          files: [new File([filename], filename)],
          types: ['Files'],
          getData: () => '',
        },
      })
    pasteFile(retainedInput, 'slow.txt')
    retainedInput.focus()
    const caretNode = retainedInput.querySelector('p')?.firstChild
    expect(caretNode?.textContent).toBe('Retained text')
    const caret = document.createRange()
    caret.setStart(caretNode!, 4)
    caret.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(caret)
    pasteFile(senderInput, 'fast.txt')
    await waitFor(() => expect(within(editor).getByText('Remove fast.txt')).toBeVisible())
    expect(within(retained).getByTestId('request-user-input-custom-scope')).toBe(retainedInput)
    expect(document.activeElement).toBe(retainedInput)
    expect(window.getSelection()?.anchorNode).toBe(caretNode)
    expect(window.getSelection()?.anchorOffset).toBe(4)
    fireEvent.click(within(editor).getByText('Remove brief.txt'))
    await act(async () =>
      finishSlow({ ...file, id: ++nextFileId, filename: 'slow.txt', local_path: '/tmp/slow.txt' })
    )
    await waitFor(() => {
      expect(within(retained).getByText('Remove fast.txt')).toBeVisible()
      expect(within(retained).getByText('Remove slow.txt')).toBeVisible()
      expect(within(retained).queryByText('Remove brief.txt')).not.toBeInTheDocument()
    })
    expect(within(retained).getByTestId('request-user-input-custom-scope')).toBe(retainedInput)
    expect(document.activeElement).toBe(retainedInput)
    expect(window.getSelection()?.anchorNode).toBe(caretNode)
    expect(window.getSelection()?.anchorOffset).toBe(4)
    fireEvent.click(within(retained).getByTestId('request-user-input-submit-button'))
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          answers: {
            details: { answers: ['B'] },
            scope: {
              answers: ['Retained text'],
              attachments: [
                expect.objectContaining({ filename: 'fast.txt' }),
                expect.objectContaining({ filename: 'slow.txt' }),
              ],
            },
          },
        })
      )
    )
  })

  test('attachment-only plan feedback selects feedback instead of implementing', async () => {
    const send = vi.fn().mockResolvedValue(false)
    render(
      <RequestUserInputCard
        payload={{
          ...payload,
          questions: [
            {
              id: 'implement',
              question: 'Implement?',
              is_other: false,
              options: [{ label: 'Implement' }],
            },
            { id: 'details', question: 'Feedback?', is_other: true },
          ],
        }}
        onSubmit={send}
        composerServices={{
          uploadAttachment: async () => file,
          renderAttachments: ({ state }) =>
            state.attachments.map(item => <span key={item.id}>{item.filename}</span>),
        }}
      />
    )
    paste()
    await waitFor(() => expect(screen.getByText('brief.txt')).toBeVisible())
    await waitFor(() => expect(submit()).toBeEnabled())
    fireEvent.click(submit())
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          answers: {
            details: {
              answers: [''],
              attachments: [expect.objectContaining({ ...file, text_content: 'brief' })],
            },
          },
        })
      )
    )
  })

  test('restores attachment-only plan feedback before selecting the implementation default', async () => {
    const send = vi.fn().mockResolvedValue(false)
    render(
      <RequestUserInputCard
        payload={{
          ...payload,
          questions: [
            {
              id: 'implement',
              question: 'Implement?',
              is_other: false,
              options: [{ label: 'Implement' }],
            },
            { id: 'details', question: 'Feedback?', is_other: true },
          ],
        }}
        draftAttachments={{ details: [file] }}
        onSubmit={send}
      />
    )
    await waitFor(() => expect(submit()).toBeEnabled())
    fireEvent.click(submit())
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          answers: { details: { answers: [''], attachments: [file] } },
        })
      )
    )
  })

  test.each([false, true])(
    'restores attachment-only custom mode while preserving explicit option selection (%s)',
    async explicitOption => {
      const send = vi.fn().mockResolvedValue(false)
      render(
        <RequestUserInputCard
          payload={{
            ...payload,
            questions: [
              { id: 'details', question: 'Continue?', is_other: true, options: [{ label: 'Yes' }] },
            ],
          }}
          draftAttachments={{ details: [file] }}
          draftOptionAnswers={explicitOption ? { details: 'Yes' } : undefined}
          onSubmit={send}
        />
      )
      await waitFor(() => expect(submit()).toBeEnabled())
      fireEvent.click(submit())
      await waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            answers: { details: { answers: [explicitOption ? 'Yes' : ''], attachments: [file] } },
          })
        )
      )
    }
  )

  test('preserves both question attachment drafts when uploads finish together', async () => {
    const finish = new Map<string, (file: Attachment) => void>()
    const drafts = vi.fn()
    const question = {
      ...payload,
      questions: [...payload.questions!, { id: 'other', question: 'Other?', is_other: true }],
    }
    render(
      <RequestUserInputCard
        payload={question}
        onSubmit={vi.fn()}
        onDraftAttachmentsChange={drafts}
        composerServices={{
          uploadAttachment: uploaded => new Promise(resolve => finish.set(uploaded.name, resolve)),
        }}
      />
    )
    paste()
    fireEvent.paste(input('other'), {
      clipboardData: {
        files: [new File(['other'], 'other.txt')],
        types: ['Files'],
        getData: () => '',
      },
    })
    await waitFor(() => expect(finish.size).toBe(2))
    const other = { ...file, id: -2, filename: 'other.txt' }
    await act(async () => {
      finish.get('brief.txt')!(file)
      finish.get('other.txt')!(other)
    })
    await waitFor(() =>
      expect(drafts).toHaveBeenLastCalledWith({
        details: [expect.objectContaining({ ...file, text_content: 'brief' })],
        other: [expect.objectContaining({ ...other, text_content: 'other' })],
      })
    )
  })

  test('retains supplied files when the shared discussion store has no draft entry', () => {
    const store: QuestionDiscussionStore = {
      accountKey: 'test',
      sessions: {},
      panelRequest: null,
      update: vi.fn(),
      requestPanel: vi.fn(),
      consumePanelRequest: vi.fn(),
      create: vi.fn(),
    }
    render(
      <QuestionDiscussionStoreContext.Provider value={store}>
        <RequestUserInputCard
          source={{ deviceId: 'device', taskId: 'task' }}
          payload={payload}
          draftAttachments={{ details: [file] }}
          onSubmit={vi.fn()}
        />
      </QuestionDiscussionStoreContext.Provider>
    )
    expect(screen.getByTestId('attachment-badge')).toHaveTextContent('brief.txt')
  })
})
