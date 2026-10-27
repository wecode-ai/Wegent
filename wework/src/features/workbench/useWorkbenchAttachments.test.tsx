import { act, renderHook } from '@testing-library/react'
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
