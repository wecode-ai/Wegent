import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import type { TaskReplyCard } from '@wegent/collaboration/execution/taskCardReply'
import { clearIssueCommentDraftsForTests, useIssueCommentDraft } from './useIssueCommentDraft'

beforeEach(clearIssueCommentDraftsForTests)

const scope = JSON.stringify(['account', 'local', 'project', 'issue'])
const reply = { root: { messageId: 'root' }, replies: [] } as unknown as TaskReplyCard

it('retains text and its reply destination across unmounts until explicitly cleared', () => {
  const first = renderHook(() => useIssueCommentDraft(scope))
  act(() => {
    first.result.current.setText('Unsent discussion')
    first.result.current.setReplyTarget(reply)
  })
  first.unmount()
  const restored = renderHook(() => useIssueCommentDraft(scope))
  expect(restored.result.current.text).toBe('Unsent discussion')
  expect(restored.result.current.replyTarget).toBe(reply)
  act(() => restored.result.current.setReplyTarget(null))
  expect(restored.result.current.text).toBe('Unsent discussion')
  act(() => restored.result.current.setText(''))
  restored.unmount()
  expect(renderHook(() => useIssueCommentDraft(scope)).result.current.text).toBe('')
})

it.each([0, 1, 2, 3])('isolates drafts when scope dimension %i changes', index => {
  const first = renderHook(() => useIssueCommentDraft(scope))
  act(() => first.result.current.setText('Original draft'))
  const parts = ['account', 'local', 'project', 'issue']
  parts[index] = 'other'
  const other = renderHook(() => useIssueCommentDraft(JSON.stringify(parts)))
  expect(other.result.current.text).toBe('')
  act(() => other.result.current.setText('Other draft'))
  expect(first.result.current.text).toBe('Original draft')
})

it('shares current edits between views without letting an old scope clear a new one', () => {
  const first = renderHook(({ key }) => useIssueCommentDraft(key), { initialProps: { key: scope } })
  const second = renderHook(() => useIssueCommentDraft(scope))
  act(() => first.result.current.setText('Shared draft'))
  expect(second.result.current.text).toBe('Shared draft')
  const clearPrevious = first.result.current.setText
  first.rerender({ key: 'another-scope' })
  act(() => first.result.current.setText('Keep this'))
  act(() => clearPrevious(''))
  expect(second.result.current.text).toBe('')
  expect(first.result.current.text).toBe('Keep this')
})
