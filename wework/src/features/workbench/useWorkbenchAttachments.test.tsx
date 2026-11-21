import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { createLocalAttachmentApi } from '@/api/local/localAttachments'
import { rememberNativeFilePath } from '@/desktop/nativeFilePaths'
import type { Attachment } from '@/types/api'
import { useWorkbenchAttachments } from './useWorkbenchAttachments'

const attachment: Attachment = {
  id: -42,
  filename: 'valid.pdf',
  file_size: 4,
  mime_type: 'application/pdf',
  file_extension: '.pdf',
  created_at: '2026-10-27T00:00:00Z',
  status: 'ready',
}

test('replaces only the current draft image after a successful markup upload', async () => {
  const original = { ...attachment, id: 41, mime_type: 'image/jpeg', filename: 'source.jpg' }
  const edited = { ...attachment, id: 42, mime_type: 'image/png', filename: 'source.png' }
  const file = new File(['markup'], edited.filename, { type: edited.mime_type })
  const remove = vi.fn().mockResolvedValue(undefined)
  let finishUpload!: (result: Attachment) => void
  const upload = vi.fn(() => new Promise<Attachment>(resolve => (finishUpload = resolve)))
  const { result } = renderHook(() =>
    useWorkbenchAttachments({
      scopeKey: 'draft',
      uploadAttachment: upload,
      deleteAttachment: remove,
    })
  )
  act(() => {
    result.current.addExistingAttachment(original)
    result.current.addExistingAttachment(attachment)
    result.current.addExistingAttachmentForScope('other', edited)
  })

  const comments = [{ x: 50, y: 50, text: 'Inspect this area' }]
  let saving!: Promise<Attachment | null>
  act(() => {
    saving = result.current.replaceImageAttachmentForScope(
      'draft',
      original.id,
      file,
      comments,
      new AbortController().signal
    )
  })
  expect(result.current.attachments).toEqual([original, attachment])
  await act(async () => {
    finishUpload(edited)
    expect(await saving).toMatchObject(edited)
  })
  expect(result.current.attachments).toEqual([
    expect.objectContaining({
      ...edited,
      image_markup_comments: comments,
    }),
    attachment,
  ])
  expect(result.current.stateByScope.other.attachments).toEqual([edited])
  expect(remove).toHaveBeenCalledExactlyOnceWith(original.id)
})

test('discards a late markup upload when the draft image has been removed', async () => {
  const original = { ...attachment, id: 41, mime_type: 'image/jpeg', filename: 'source.jpg' }
  const edited = { ...attachment, id: 42, mime_type: 'image/png', filename: 'source.png' }
  let finishUpload!: (result: Attachment) => void
  const upload = vi.fn(() => new Promise<Attachment>(resolve => (finishUpload = resolve)))
  const remove = vi.fn().mockResolvedValue(undefined)
  const { result } = renderHook(() =>
    useWorkbenchAttachments({
      scopeKey: 'draft',
      uploadAttachment: upload,
      deleteAttachment: remove,
    })
  )
  act(() => result.current.addExistingAttachment(original))
  const saving = result.current.replaceImageAttachmentForScope(
    'draft',
    original.id,
    new File(['markup'], edited.filename, { type: edited.mime_type }),
    [],
    new AbortController().signal
  )
  await act(async () => {
    await result.current.removeAttachment(original.id)
    finishUpload(edited)
    expect(await saving).toBeNull()
  })
  expect(result.current.attachments).toEqual([])
  expect(remove.mock.calls).toEqual([[original.id], [edited.id]])
})

test('stages a large native file through the shared composer with only a bounded text preview', async () => {
  const file = new File(['test log content'], 'large.log', { type: 'text/plain' })
  Object.defineProperty(file, 'size', { value: 378989795 })
  rememberNativeFilePath(file, '/Users/alice/large.log')
  const readText = vi.spyOn(file, 'text')
  const readBytes = vi.spyOn(file, 'arrayBuffer')
  const readChunk = vi.spyOn(file, 'slice')
  const api = createLocalAttachmentApi()
  const { result } = renderHook(() => useWorkbenchAttachments(api))

  await act(async () => result.current.handleFileSelect(file))

  expect(result.current.attachments).toMatchObject([
    {
      local_path: '/Users/alice/large.log',
      file_size: 378989795,
      text_preview: 'test log content',
      text_content: null,
      text_length: null,
      status: 'ready',
    },
  ])
  expect(readText).not.toHaveBeenCalled()
  expect(readBytes).not.toHaveBeenCalled()
  expect(readChunk).toHaveBeenCalledExactlyOnceWith(0, 4096)
  expect(result.current.errors.size).toBe(0)
  expect(result.current.isAttachmentReadyToSend).toBe(true)
})

test('dismisses only the addressed error while retaining valid attachments and other scopes', async () => {
  const upload = vi.fn().mockRejectedValue(new Error('disk full'))
  const { result } = renderHook(() =>
    useWorkbenchAttachments({ scopeKey: 'first', uploadAttachment: upload })
  )
  const failed = new File(['test'], 'failed.pdf')
  const other = new File(['test'], 'other.pdf')
  act(() => result.current.addExistingAttachment(attachment))
  await act(async () => {
    await result.current.handleFileSelect([failed, other])
    await result.current.handleFileSelectForScope('second', failed)
  })

  expect(result.current.errors).toEqual(
    new Map([
      ['failed.pdf', 'disk full'],
      ['other.pdf', 'disk full'],
    ])
  )
  act(() => result.current.dismissAttachmentError('failed.pdf'))

  expect(result.current.errors).toEqual(new Map([['other.pdf', 'disk full']]))
  expect(result.current.stateByScope.second.errors).toEqual(new Map([['failed.pdf', 'disk full']]))
  expect(result.current.attachments).toEqual([attachment])
  expect(result.current.isAttachmentReadyToSend).toBe(true)

  act(() => result.current.dismissAttachmentErrorForScope('second', 'failed.pdf'))
  expect(result.current.stateByScope.second.errors.size).toBe(0)
  expect(result.current.errors.size).toBe(1)
})

test('clears a previous error when the same file is reselected and completes the retry', async () => {
  let finishUpload!: (attachment: Attachment) => void
  const upload = vi
    .fn()
    .mockRejectedValueOnce(new Error('disk full'))
    .mockImplementationOnce(
      () =>
        new Promise<Attachment>(resolve => {
          finishUpload = resolve
        })
    )
  const file = new File(['test'], 'valid.pdf')
  const { result } = renderHook(() => useWorkbenchAttachments({ uploadAttachment: upload }))
  await act(async () => result.current.handleFileSelect(file))
  expect(result.current.errors.size).toBe(1)

  let retry!: Promise<void>
  act(() => {
    retry = result.current.handleFileSelect(file)
  })
  expect(result.current.errors.size).toBe(0)
  expect(result.current.isUploading).toBe(true)
  await act(async () => {
    finishUpload(attachment)
    await retry
  })

  expect(result.current.errors.size).toBe(0)
  expect(result.current.attachments).toEqual([attachment])
  expect(result.current.isAttachmentReadyToSend).toBe(true)
})

test.each(['before', 'after'])(
  'ignores an older attempt failing %s the reselected file succeeds',
  async failureOrder => {
    let failFirst!: (error: Error) => void
    let finishRetry!: (attachment: Attachment) => void
    const upload = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Attachment>((_, reject) => (failFirst = reject)))
      .mockImplementationOnce(() => new Promise<Attachment>(resolve => (finishRetry = resolve)))
    const { result } = renderHook(() => useWorkbenchAttachments({ uploadAttachment: upload }))
    const file = new File(['test'], 'valid.pdf')
    let first!: Promise<void>
    let retry!: Promise<void>
    act(() => {
      first = result.current.handleFileSelect(file)
      retry = result.current.handleFileSelect(file)
    })
    expect(result.current.uploadingFiles.size).toBe(2)

    const fail = async () => {
      await act(async () => {
        failFirst(new Error('older failure'))
        await first
      })
      expect(result.current.errors.size).toBe(0)
    }
    if (failureOrder === 'before') await fail()
    await act(async () => {
      finishRetry(attachment)
      await retry
    })
    if (failureOrder === 'after') await fail()

    expect(result.current.attachments).toEqual([attachment])
    expect(result.current.uploadingFiles.size).toBe(0)
    expect(result.current.isAttachmentReadyToSend).toBe(true)
  }
)

test('tracks concurrent failures of the same filename independently in each scope', async () => {
  const failures: Array<(error: Error) => void> = []
  const upload = vi.fn(() => new Promise<Attachment>((_, reject) => failures.push(reject)))
  const { result } = renderHook(() =>
    useWorkbenchAttachments({ scopeKey: 'first', uploadAttachment: upload })
  )
  const file = new File(['test'], 'same.pdf')
  let first!: Promise<void>
  let second!: Promise<void>
  act(() => {
    first = result.current.handleFileSelect(file)
    second = result.current.handleFileSelectForScope('second', file)
  })
  await act(async () => {
    failures[0](new Error('first scope failure'))
    await first
    failures[1](new Error('second scope failure'))
    await second
  })

  expect(result.current.errors.get('same.pdf')).toBe('first scope failure')
  expect(result.current.stateByScope.second.errors.get('same.pdf')).toBe('second scope failure')
})

test('admits every selected file before upload and retains the submitted files across draft reset', async () => {
  const { localRuntimeAttachments, resolvePreparingAttachments } =
    await import('@/lib/runtime-attachments')
  let finish!: (attachment: Attachment) => void
  const upload = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Attachment>(resolve => {
          finish = resolve
        })
    )
    .mockResolvedValueOnce({
      ...attachment,
      id: -43,
      filename: 'second.png',
      local_path: '/draft/second.png',
    })
  const { result } = renderHook(() =>
    useWorkbenchAttachments({ scopeKey: 'chat', uploadAttachment: upload })
  )
  let selecting!: Promise<void>
  let accepted!: Attachment[]
  act(() => {
    selecting = result.current.handleFileSelect([
      new File(['first'], 'first.png', { type: 'image/png' }),
      new File(['second'], 'second.png', { type: 'image/png' }),
    ])
    accepted = result.current.captureAttachmentsForScope('chat')
    result.current.resetAttachments()
  })
  expect(accepted.map(file => file.filename)).toEqual(['first.png', 'second.png'])
  let delivered = false
  const preparing = resolvePreparingAttachments(localRuntimeAttachments(accepted)).then(files => {
    delivered = true
    return files
  })
  await act(async () => {
    await Promise.resolve()
  })
  expect(delivered).toBe(false)
  act(() =>
    result.current.addExistingAttachment({ ...attachment, id: -44, filename: 'new-draft.pdf' })
  )
  await act(async () => {
    finish({ ...attachment, filename: 'first.png', local_path: '/draft/first.png' })
    await selecting
  })
  expect((await preparing).map(file => file.local_path)).toEqual([
    '/draft/first.png',
    '/draft/second.png',
  ])
  expect(result.current.attachments.map(file => file.filename)).toEqual(['new-draft.pdf'])
  expect(result.current.uploadingFiles.size).toBe(0)
})

test('fails the accepted attachment preparation when upload fails instead of delivering text alone', async () => {
  const { resolvePreparingAttachments } = await import('@/lib/runtime-attachments')
  let fail!: (error: Error) => void
  const upload = vi.fn(
    () =>
      new Promise<Attachment>((_, reject) => {
        fail = reject
      })
  )
  const { result } = renderHook(() =>
    useWorkbenchAttachments({ scopeKey: 'chat', uploadAttachment: upload })
  )
  let selecting!: Promise<void>
  let accepted!: Attachment[]
  act(() => {
    selecting = result.current.handleFileSelect(new File(['image'], 'failed.png'))
    accepted = result.current.captureAttachmentsForScope('chat')
    result.current.resetAttachments()
  })
  const preparing = expect(resolvePreparingAttachments(accepted)).rejects.toThrow('disk full')
  await act(async () => {
    fail(new Error('disk full'))
    await selecting
    await preparing
  })
  expect(result.current.attachments).toEqual([])
  upload.mockResolvedValueOnce({ ...attachment, id: -43, filename: 'recovered.png' })
  act(() => result.current.addExistingAttachment(accepted[0]))
  await waitFor(() => expect(result.current.attachments.map(file => file.id)).toEqual([-43]))
  expect(upload).toHaveBeenCalledTimes(2)
})

test('does not capture a cleared draft upload when a newer message is submitted', async () => {
  let finish!: (value: Attachment) => void
  const upload = vi.fn(
    () =>
      new Promise<Attachment>(resolve => {
        finish = resolve
      })
  )
  const remove = vi.fn().mockResolvedValue(undefined)
  const { result } = renderHook(() =>
    useWorkbenchAttachments({
      scopeKey: 'chat',
      uploadAttachment: upload,
      deleteAttachment: remove,
    })
  )
  let selecting!: Promise<void>
  act(() => {
    selecting = result.current.handleFileSelect(new File(['image'], 'cleared.png'))
    result.current.resetAttachments()
  })
  expect(result.current.captureAttachmentsForScope('chat')).toEqual([])
  await act(async () => {
    finish({ ...attachment, id: 42 })
    await selecting
  })
  expect(remove).toHaveBeenCalledWith(42)
  expect(result.current.attachments).toEqual([])
})
