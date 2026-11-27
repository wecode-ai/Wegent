import { expect, it, vi } from 'vitest'
import { createWebCommentDraft } from './webCommentDraft'
import type { CollaborationComment } from '../types'

const comment = { id: 'comment' } as CollaborationComment
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function command() {
  return {
    body: 'body',
    mentions: undefined,
    send: vi.fn(async () => comment),
    onSent: vi.fn(),
    onError: vi.fn(),
    resetAttachments: vi.fn(),
  }
}

it('locks before notifying subscribers and only clears a successfully handled draft', async () => {
  const draft = createWebCommentDraft()
  const stop = draft.subscribe(vi.fn())
  draft.setDraft('Keep until sent')
  const pending = deferred<CollaborationComment>()
  const submit = { ...command(), send: vi.fn(() => pending.promise) }
  submit.onSent.mockImplementation(() => {
    expect(draft.getSnapshot()).toMatchObject({ draft: 'Keep until sent', sending: true })
  })
  const first = draft.submit(submit)
  expect(await draft.submit(submit)).toBe(false)
  expect(submit.send).toHaveBeenCalledExactlyOnceWith('body')
  pending.resolve(comment)
  expect(await first).toBe(true)
  expect(draft.getSnapshot()).toEqual({ draft: '', sending: false, failure: null })
  expect(submit.resetAttachments).toHaveBeenCalledOnce()
  stop()
})

it('preserves text and attachments when processing a sent comment fails and permits retry', async () => {
  const draft = createWebCommentDraft()
  const stop = draft.subscribe(vi.fn())
  draft.setDraft('Retry me')
  const submit = command()
  const failure = new Error('refresh failed')
  submit.onSent.mockImplementationOnce(() => {
    throw failure
  })
  expect(await draft.submit(submit)).toBe(false)
  expect(draft.getSnapshot()).toEqual({
    draft: 'Retry me',
    sending: false,
    failure: { cause: failure },
  })
  expect(submit.resetAttachments).not.toHaveBeenCalled()
  expect(submit.onError).toHaveBeenCalledOnce()
  expect(await draft.submit(submit)).toBe(true)
  expect(draft.getSnapshot().failure).toBeNull()
  stop()
})

it('does not authorize follow-up actions when an old owner receives a successful send', async () => {
  const draft = createWebCommentDraft()
  const stop = draft.subscribe(vi.fn())
  const pending = deferred<CollaborationComment>()
  const submit = { ...command(), send: vi.fn(() => pending.promise) }
  const request = draft.submit(submit)
  stop()
  pending.resolve(comment)
  expect(await request).toBe(false)
  expect(submit.onSent).not.toHaveBeenCalled()
  expect(submit.resetAttachments).not.toHaveBeenCalled()
  expect(submit.onError).not.toHaveBeenCalled()
})
