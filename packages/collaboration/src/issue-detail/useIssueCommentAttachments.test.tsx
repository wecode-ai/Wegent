// @vitest-environment jsdom
import { act, createRef, useImperativeHandle } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useIssueCommentAttachments } from './useIssueCommentAttachments'
import type { CollaborationAttachment } from '../types'

const attachment = {
  id: 'old',
  display_name: 'report.bin',
  markdown_url: 'wegent://attachments/old',
} as CollaborationAttachment
const file = new File(['content'], 'report.bin', {
  type: 'application/octet-stream',
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
const current = createRef<ReturnType<typeof useIssueCommentAttachments>>()
let root: Root
let container: HTMLDivElement
function Harness({
  upload,
  scope,
}: {
  upload: (file: File) => Promise<CollaborationAttachment>
  scope?: unknown
}) {
  const selection = useIssueCommentAttachments(upload, undefined, scope)
  useImperativeHandle(current, () => selection, [selection])
  return null
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('invalidates a pending upload when its draft selection is reset', async () => {
  const pending = deferred<CollaborationAttachment>()
  const upload = vi.fn(() => pending.promise)
  await act(async () => root.render(<Harness upload={upload} />))
  let operation: void | Promise<void> = undefined
  act(() => {
    operation = current.current!.handleFileSelect([file])
  })
  expect(current.current!.isAttachmentReadyToSend).toBe(false)
  act(() => current.current!.resetAttachments())
  expect(current.current!.isAttachmentReadyToSend).toBe(true)
  await act(async () => {
    pending.resolve(attachment)
    await operation
  })
  expect(current.current!.attachments).toEqual([])
})

it('does not continue uploading the rest of a batch after its owner unmounts', async () => {
  const pending = deferred<CollaborationAttachment>()
  const upload = vi.fn(() => pending.promise)
  await act(async () => root.render(<Harness upload={upload} />))
  let operation: void | Promise<void> = undefined
  act(() => {
    operation = current.current!.handleFileSelect([file, file])
  })
  expect(current.current!.uploadingFiles.size).toBe(2)
  act(() => root.render(null))
  await act(async () => {
    pending.resolve(attachment)
    await operation
  })
  expect(upload).toHaveBeenCalledTimes(1)
})

it('does not attach an old issue response after switching to another draft scope', async () => {
  const pending = deferred<CollaborationAttachment>()
  const upload = vi.fn(() => pending.promise)
  await act(async () => root.render(<Harness upload={upload} scope="issue-a" />))
  let operation: void | Promise<void> = undefined
  act(() => {
    operation = current.current!.handleFileSelect([file])
  })
  await act(async () => root.render(<Harness upload={upload} scope="issue-b" />))
  expect(current.current!.uploadingFiles.size).toBe(0)
  await act(async () => {
    pending.resolve(attachment)
    await operation
  })
  expect(current.current!.attachments).toEqual([])
})

it('does not let a reset upload finish or clear a newer batch', async () => {
  const old = deferred<CollaborationAttachment>()
  const fresh = deferred<CollaborationAttachment>()
  const upload = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  await act(async () => root.render(<Harness upload={upload} />))
  let first: void | Promise<void> = undefined
  let second: void | Promise<void> = undefined
  act(() => {
    first = current.current!.handleFileSelect([file])
  })
  act(() => current.current!.resetAttachments())
  act(() => {
    second = current.current!.handleFileSelect([file])
  })
  await act(async () => {
    old.resolve(attachment)
    await first
  })
  expect(current.current!.attachments).toEqual([])
  expect(current.current!.uploadingFiles.size).toBe(1)
  await act(async () => {
    fresh.resolve({ ...attachment, id: 'new' })
    await second
  })
  expect(current.current!.attachments.map(item => item.id)).toEqual(['new'])
  expect(current.current!.isAttachmentReadyToSend).toBe(true)
})

it('keeps files in the same scope while using updated upload callbacks for subsequent picks', async () => {
  const first = vi.fn(async () => attachment)
  const second = vi.fn(async () => ({ ...attachment, id: 'new' }))
  await act(async () => root.render(<Harness upload={first} scope="issue" />))
  await act(async () => current.current!.handleFileSelect([file]))
  await act(async () => root.render(<Harness upload={second} scope="issue" />))
  expect(current.current!.attachments.map(item => item.id)).toEqual(['old'])
  await act(async () => current.current!.handleFileSelect([file]))
  expect(first).toHaveBeenCalledOnce()
  expect(second).toHaveBeenCalledOnce()
  expect(current.current!.attachments.map(item => item.id)).toEqual(['old', 'new'])
})

it('does not publish text metadata that finishes after switching scopes', async () => {
  const text = deferred<string>()
  const textFile = new File(['content'], 'report.txt', { type: 'text/plain' })
  const read = vi.fn(() => text.promise)
  Object.defineProperty(textFile, 'text', { value: read })
  const upload = vi.fn(async () => attachment)
  await act(async () => root.render(<Harness upload={upload} scope="first" />))
  let operation: void | Promise<void> = undefined
  await act(async () => {
    operation = current.current!.handleFileSelect([textFile])
  })
  expect(read).toHaveBeenCalledOnce()
  await act(async () => root.render(<Harness upload={upload} scope="next" />))
  await act(async () => {
    text.resolve('private content')
    await operation
  })
  expect(current.current!.attachments).toEqual([])
  expect(current.current!.isAttachmentReadyToSend).toBe(true)
})
