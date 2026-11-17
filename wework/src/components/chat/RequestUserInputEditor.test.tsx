import '@/i18n'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { setComposerValue } from '@/test/composer'
import { RequestUserInputCard, RequestUserInputSummary } from './RequestUserInputCard'
import type { Attachment, RequestUserInputPayload } from '@/types/api'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import { composeDesktopInput } from '@/e2e/input-composition'

const payload: RequestUserInputPayload = {
  requestId: 12,
  questions: [{ id: 'details', question: 'Describe the result', is_other: true }],
}
const attachment: Attachment = {
  id: -7,
  filename: 'brief.txt',
  file_size: 4,
  mime_type: 'text/plain',
  status: 'ready',
  file_extension: '.txt',
  created_at: '',
  local_path: '/tmp/brief.txt',
}
const input = () => screen.getByTestId('request-user-input-custom-details')
const submitButton = () => screen.getByTestId('request-user-input-submit-button')
const clipboard = (files: File[]) => ({ files, types: ['Files'], getData: () => '' })

describe('question answer editor', () => {
  test('preserves IME text through the shared desktop composition control', async () => {
    render(<RequestUserInputCard payload={payload} onSubmit={vi.fn()} />)
    const result = await composeDesktopInput(input(), ['bao', 'baoliu', '保留回答'], async () => {
      await act(async () => {})
    })
    expect(result.writes).toEqual([])
    expect(result.steps).toEqual(
      ['bao', 'baoliu', '保留回答'].map(value => ({
        value,
        actual: value,
        focused: true,
        connected: true,
      }))
    )
    expect(result.value).toBe('保留回答')
    expect(input()).toHaveValue('保留回答')
  })

  test('skips an async question without submitting or losing its draft', async () => {
    const submit = vi.fn()
    const skip = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const collapse = vi.fn()
    render(
      <RequestUserInputCard
        payload={{ ...payload, delivery: 'async' }}
        onSubmit={submit}
        onSkip={skip}
        onCollapse={collapse}
        draftAttachments={{ details: [attachment] }}
      />
    )
    setComposerValue(input(), 'Keep this draft')
    fireEvent.click(screen.getByTestId('request-user-input-skip-button'))
    await waitFor(() => expect(skip).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('request-user-input-skipped')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('request-user-input-skip-button'))
    await waitFor(() => expect(screen.getByTestId('request-user-input-skipped')).toBeVisible())
    expect(screen.getByTestId('request-user-input-card')).not.toBeVisible()
    expect(submit).not.toHaveBeenCalled()
    expect(collapse).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('request-user-input-skipped'))
    expect(input()).toHaveValue('Keep this draft')
    expect(screen.getByTestId('attachment-badge')).toHaveTextContent('brief.txt')
  })

  test('skips async questions locally without requiring an answer handler', async () => {
    render(<RequestUserInputCard payload={{ ...payload, delivery: 'async' }} />)
    fireEvent.click(screen.getByTestId('request-user-input-skip-button'))
    await waitFor(() => expect(screen.getByTestId('request-user-input-skipped')).toBeVisible())
  })

  test('shows newly arriving questions after skipping the previous ones', async () => {
    const submit = vi.fn()
    const question = { ...payload, delivery: 'async' as const }
    const view = render(<RequestUserInputCard payload={question} onSubmit={submit} />)
    fireEvent.click(screen.getByTestId('request-user-input-skip-button'))
    await waitFor(() => expect(screen.getByTestId('request-user-input-skipped')).toBeVisible())
    view.rerender(
      <RequestUserInputCard
        payload={{
          ...question,
          questions: [...question.questions!, { id: 'new', question: 'Another question' }],
        }}
        onSubmit={submit}
      />
    )
    expect(screen.getByTestId('request-user-input-card')).toBeVisible()
    expect(screen.getByText('Another question')).toBeVisible()
    expect(submit).not.toHaveBeenCalled()
  })

  test('offers skip for a business question that only has preset options', async () => {
    const submit = vi.fn().mockResolvedValue(false)
    render(
      <RequestUserInputCard
        payload={{
          ...payload,
          questions: [
            {
              id: 'details',
              question: 'Choose a scope',
              is_other: false,
              options: [{ label: 'Everyone' }],
            },
          ],
        }}
        onSubmit={submit}
      />
    )
    fireEvent.click(screen.getByTestId('request-user-input-skip-button'))
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({ answers: { details: { answers: [] } } })
      )
    )
  })
  test('shows answered filenames without rendering the native attachment instructions', () => {
    render(
      <RequestUserInputSummary
        payload={{
          ...payload,
          response: {
            requestId: 12,
            answers: { details: { answers: ['Reviewed'], attachments: [attachment] } },
          },
        }}
      />
    )
    expect(screen.getByTestId('request-user-input-summary')).toHaveTextContent('Reviewed')
    expect(screen.getByTestId('request-user-input-summary')).toHaveTextContent('brief.txt')
    expect(screen.getByTestId('request-user-input-summary')).not.toHaveTextContent('/tmp/')
  })
  test('captures clipboard files before the browser closes the transfer event', async () => {
    const upload = vi.fn().mockResolvedValue(attachment)
    const data = clipboard([new File(['file'], 'brief.txt')])
    const resolveTransfer = vi.fn(async (data: { files: File[] }) => ({
      referenceEntries: [],
      attachmentFiles: [...data.files],
    }))
    render(
      <RequestUserInputCard
        payload={payload}
        onSubmit={vi.fn()}
        composerServices={{
          uploadAttachment: upload,
          transferServices: { hasPathTransfer: () => true, resolveTransfer },
        }}
      />
    )
    fireEvent.paste(input(), { clipboardData: data })
    data.files = []
    expect(resolveTransfer).toHaveBeenCalledOnce()
    await waitFor(() => expect(upload).toHaveBeenCalledOnce())
    await waitFor(() => expect(submitButton()).toBeEnabled())
  })

  test('preserves source files until the owning handler chooses Issue storage and executor transport', async () => {
    const submit = vi.fn().mockResolvedValue(false)
    const upload = vi.fn().mockResolvedValue({ ...attachment, id: 42 })
    const context = {
      state: { devices: [{ device_id: 'cloud', device_type: 'cloud' }] },
      services: { attachmentApi: { uploadLocalAttachmentToCloud: upload } },
    } as unknown as NonNullable<import('react').ContextType<typeof WorkbenchContext>>
    render(
      <WorkbenchContext.Provider value={context}>
        <RequestUserInputCard
          source={{ deviceId: 'cloud', taskId: 'question' }}
          payload={payload}
          draftAttachments={{ details: [attachment] }}
          onSubmit={submit}
        />
      </WorkbenchContext.Provider>
    )
    fireEvent.click(submitButton())
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({
          answers: {
            details: {
              answers: [''],
              attachments: [expect.objectContaining({ id: -7, local_path: '/tmp/brief.txt' })],
            },
          },
        })
      )
    )
    expect(upload).not.toHaveBeenCalled()
  })
  test('keeps the same controlled editor and draft when another question arrives', () => {
    const submit = vi.fn()
    const view = render(<RequestUserInputCard payload={payload} onSubmit={submit} />)
    const original = input()
    setComposerValue(original, 'STAFF')
    view.rerender(
      <RequestUserInputCard
        payload={{
          ...payload,
          questions: [...payload.questions!, { id: 'format', question: 'Format?' }],
        }}
        onSubmit={submit}
      />
    )
    expect(input()).toBe(original)
    expect(input()).toHaveValue('STAFF')
    expect(input()).toHaveTextContent('STAFF')
    expect(input()).not.toHaveAttribute('value')
  })
  test('waits for native clipboard resolution and allows skipping without sending its files', async () => {
    let resolve!: (value: { referenceEntries: []; attachmentFiles: File[] }) => void
    const submit = vi.fn().mockResolvedValue(false)
    const upload = vi.fn().mockResolvedValue(attachment)
    render(
      <RequestUserInputCard
        payload={payload}
        onSubmit={submit}
        composerServices={{
          uploadAttachment: upload,
          transferServices: {
            hasPathTransfer: () => true,
            resolveTransfer: () =>
              new Promise(finish => {
                resolve = finish
              }),
          },
        }}
      />
    )
    fireEvent.paste(input(), { clipboardData: clipboard([]) })
    await waitFor(() => expect(submitButton()).toBeDisabled())
    fireEvent.click(screen.getByTestId('request-user-input-skip-button'))
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({ answers: { details: { answers: [] } } })
      )
    )
    await act(async () =>
      resolve({ referenceEntries: [], attachmentFiles: [new File(['file'], 'brief.txt')] })
    )
    await waitFor(() => expect(submitButton()).toBeEnabled())
    expect(upload).toHaveBeenCalledOnce()
  })

  test('restores attachments with the question and removes them through the existing file lifecycle', async () => {
    const submit = vi.fn().mockResolvedValue(false)
    const drafts = vi.fn()
    render(
      <RequestUserInputCard
        payload={payload}
        onSubmit={submit}
        draftAttachments={{ details: [attachment] }}
        onDraftAttachmentsChange={drafts}
        composerServices={{
          renderAttachments: ({ state, remove }) =>
            state.attachments.map(file => (
              <button
                key={file.id}
                data-testid="remove-restored-file"
                onClick={() => remove(file.id)}
              >
                {file.filename}
              </button>
            )),
        }}
      />
    )
    expect(screen.getByTestId('remove-restored-file')).toHaveTextContent('brief.txt')
    fireEvent.click(screen.getByTestId('remove-restored-file'))
    await waitFor(() =>
      expect(screen.queryByTestId('remove-restored-file')).not.toBeInTheDocument()
    )
    expect(drafts).toHaveBeenLastCalledWith({ details: [] })
    fireEvent.click(submitButton())
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({ answers: { details: { answers: [''] } } })
      )
    )
  })

  test('uses the shared multiline editor, preserves Shift+Enter and submits with Enter', async () => {
    const submit = vi.fn().mockResolvedValue(false)
    render(<RequestUserInputCard payload={payload} onSubmit={submit} />)
    expect(input()).toHaveAttribute('contenteditable', 'true')
    expect(input()).toHaveAccessibleName('Describe the result')
    setComposerValue(input(), 'First line')
    fireEvent.keyDown(input(), { key: 'Enter', code: 'Enter', shiftKey: true })
    expect(submit).not.toHaveBeenCalled()
    expect(input()).toHaveValue('First line\n')
    setComposerValue(input(), 'First line\nSecond line')
    fireEvent.keyDown(input(), { key: 'Enter', code: 'Enter' })
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({
          answers: { details: { answers: ['First line\nSecond line'] } },
        })
      )
    )
  })

  test('does not submit Enter while confirming Chinese composition', () => {
    const submit = vi.fn()
    render(<RequestUserInputCard payload={payload} onSubmit={submit} />)
    fireEvent.compositionStart(input())
    setComposerValue(input(), '中文回答')
    fireEvent.keyDown(input(), { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 })
    fireEvent.compositionEnd(input())
    fireEvent.keyDown(input(), { key: 'Enter', code: 'Enter' })
    expect(submit).not.toHaveBeenCalled()
  })

  test('keeps custom text separate from options and preserves it after an option is selected', async () => {
    const submit = vi.fn().mockResolvedValue(false)
    render(
      <RequestUserInputCard
        payload={{
          ...payload,
          questions: [
            {
              ...payload.questions![0],
              options: [{ label: 'Staff' }, { label: 'Everyone' }],
            },
          ],
        }}
        onSubmit={submit}
      />
    )
    expect(input()).toHaveValue('')
    setComposerValue(input(), 'Staff with a written exception')
    fireEvent.click(screen.getByTestId('request-user-input-option-details-1'))
    await waitFor(() =>
      expect(submit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          answers: { details: { answers: ['Everyone'] } },
        })
      )
    )
    expect(input()).toHaveValue('Staff with a written exception')
    fireEvent.keyDown(input(), { key: 'Enter', code: 'Enter' })
    await waitFor(() =>
      expect(submit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          answers: { details: { answers: ['Staff with a written exception'] } },
        })
      )
    )
  })

  test('waits for files, submits real attachment metadata and retains files on rejection', async () => {
    let finish!: (value: Attachment) => void
    const upload = vi.fn(
      () =>
        new Promise<Attachment>(resolve => {
          finish = resolve
        })
    )
    const submit = vi.fn().mockResolvedValue(false)
    const drafts = vi.fn()
    render(
      <RequestUserInputCard
        payload={payload}
        onSubmit={submit}
        onDraftAttachmentsChange={drafts}
        composerServices={{ uploadAttachment: upload }}
      />
    )
    const file = new File(['file'], 'brief.txt', { type: 'text/plain' })
    fireEvent.paste(input(), { clipboardData: clipboard([file]) })
    await waitFor(() => expect(upload).toHaveBeenCalledWith(file, expect.any(Function)))
    expect(submitButton()).toBeDisabled()
    await act(async () => finish(attachment))
    await waitFor(() => expect(submitButton()).toBeEnabled())
    fireEvent.click(submitButton())
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({
          answers: {
            details: {
              answers: [''],
              attachments: [expect.objectContaining({ local_path: '/tmp/brief.txt' })],
            },
          },
        })
      )
    )
    expect(drafts).toHaveBeenCalledWith({
      details: [expect.objectContaining({ filename: 'brief.txt' })],
    })
    expect(submitButton()).toBeEnabled()
  })

  test('keeps failed files visible, blocks submission and allows a new paste to recover', async () => {
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error('Disk is full'))
      .mockResolvedValue(attachment)
    const submit = vi.fn().mockResolvedValue(false)
    render(
      <RequestUserInputCard
        payload={payload}
        onSubmit={submit}
        composerServices={{ uploadAttachment: upload }}
      />
    )
    const file = new File(['file'], 'brief.txt', { type: 'text/plain' })
    fireEvent.paste(input(), { clipboardData: clipboard([file]) })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Disk is full'))
    expect(submitButton()).toBeDisabled()
    fireEvent.paste(input(), { clipboardData: clipboard([file]) })
    await waitFor(() => expect(submitButton()).toBeEnabled())
    fireEvent.click(submitButton())
    await waitFor(() => expect(submit).toHaveBeenCalledOnce())
  })

  test('skip submits empty answers while collapse preserves the request, and failure remains retryable', async () => {
    const submit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const collapse = vi.fn()
    render(<RequestUserInputCard payload={payload} onSubmit={submit} onCollapse={collapse} />)
    setComposerValue(input(), 'Keep this draft')
    fireEvent.click(screen.getByTestId('request-user-input-ignore-button'))
    expect(collapse).toHaveBeenCalledOnce()
    expect(submit).not.toHaveBeenCalled()
    const skip = screen.getByTestId('request-user-input-skip-button')
    fireEvent.click(skip)
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith({
        requestId: 12,
        itemId: undefined,
        answers: { details: { answers: [] } },
      })
    )
    expect(input()).toHaveValue('Keep this draft')
    expect(skip).toBeEnabled()
    fireEvent.click(skip)
    await waitFor(() => expect(skip).toBeDisabled())
  })

  test.each(['approval', 'mcp_form', 'mcp_url'])(
    'does not offer business skip on %s',
    interactionKind => {
      render(<RequestUserInputCard payload={{ ...payload, interactionKind }} onSubmit={vi.fn()} />)
      expect(screen.queryByTestId('request-user-input-skip-button')).not.toBeInTheDocument()
    }
  )
})
