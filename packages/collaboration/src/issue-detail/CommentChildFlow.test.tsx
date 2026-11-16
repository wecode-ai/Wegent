// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useCommentAssignment } from './useCommentAssignment'
import { useCommentChildIssue } from './useCommentChildIssue'
import type { CollaborationIssue, CollaborationProject } from '../types'

let root: Root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  root = createRoot(document.createElement('div'))
})
afterEach(() => root.unmount())

it('persists the parent comment before creating a child and retries without resending or reassigning the parent', async () => {
  const assign = vi.fn(),
    child = vi
      .fn()
      .mockRejectedValueOnce(new Error('Assignment unavailable'))
      .mockResolvedValue({ id: 'child' })
  const send = vi.fn().mockResolvedValue(true)
  let flow!: ReturnType<typeof useCommentAssignment>
  function Harness() {
    flow = useCommentAssignment(
      'Please implement this',
      { options: [{ value: '7', label: 'Owner' }], assign, createChild: child },
      send,
    )
    return null
  }
  act(() => root.render(<Harness />))
  act(() => {
    flow.setMode('child')
    flow.setTarget('7')
  })
  await act(() => flow.submit('Please implement this'))
  expect(send).toHaveBeenCalledWith('Please implement this', [], {
    commentOnly: true,
  })
  expect(send.mock.invocationCallOrder[0]).toBeLessThan(
    child.mock.invocationCallOrder[0],
  )
  expect(flow.error).toBe('Assignment unavailable')
  const request = child.mock.calls[0][0]
  await act(() => flow.submit(''))
  expect(send).toHaveBeenCalledOnce()
  expect(child).toHaveBeenLastCalledWith(request)
  expect(assign).not.toHaveBeenCalled()
  expect(flow.pendingChild).toBeNull()
})

it('does not create a child when its parent comment fails', async () => {
  const child = vi.fn(),
    send = vi.fn().mockResolvedValue(false)
  let flow!: ReturnType<typeof useCommentAssignment>
  function Harness() {
    flow = useCommentAssignment(
      'Work',
      { options: [], assign: vi.fn(), createChild: child },
      send,
    )
    return null
  }
  act(() => root.render(<Harness />))
  act(() => flow.setMode('child'))
  await act(() => flow.submit('Work'))
  expect(child).not.toHaveBeenCalled()
})

it('creates one child across assignment failure, keeps the parent unchanged, and preserves its original comment body', async () => {
  const parent = {
    id: 'parent',
    cloud_project_id: 'p',
    sequence_number: 3,
    title: 'Parent',
    priority: 'high',
    assignee_user_id: 9,
  } as CollaborationIssue
  const child = {
    ...parent,
    id: 'child',
    parent_id: 'parent',
    assignee_user_id: null,
  }
  const create = vi.fn().mockResolvedValue(child),
    get = vi.fn().mockResolvedValue(child)
  const assign = vi
    .fn()
    .mockRejectedValueOnce(new Error('Conflict'))
    .mockResolvedValue({ ...child, assignee_user_id: 7 })
  let run!: ReturnType<typeof useCommentChildIssue>
  function Harness() {
    run = useCommentChildIssue({
      port: { issues: { create, get } as never },
      project: { id: 'p', project_store: 'local' } as CollaborationProject,
      parent,
      resolveTarget: async (target) => target,
      assign,
      onCreated: vi.fn(),
    })
    return null
  }
  act(() => root.render(<Harness />))
  const input = {
    body: 'A request without any mention',
    target: '7',
    requestId: 'operation-1',
    sourceMessageId: 'comment-1',
  }
  await expect(run(input)).rejects.toThrow('Conflict')
  await expect(run(input)).resolves.toMatchObject({
    id: 'child',
    assignee_user_id: 7,
  })
  expect(create).toHaveBeenCalledOnce()
  expect(create).toHaveBeenCalledWith(
    'p',
    expect.objectContaining({
      request_id: 'operation-1',
      parent_id: 'parent',
      assignee_user_id: 7,
      description: expect.stringContaining(input.body),
    }),
  )
  expect(assign.mock.calls.every(([source]) => source.id === 'child')).toBe(
    true,
  )
  expect(parent.assignee_user_id).toBe(9)
})

it('submits normal replies when child assignment becomes unavailable', async () => {
  const send = vi.fn().mockResolvedValue(true)
  let flow!: ReturnType<typeof useCommentAssignment>
  function Harness({ replies = false }: { replies?: boolean }) {
    flow = useCommentAssignment(
      'Reply',
      replies
        ? undefined
        : {
            options: [],
            assign: vi.fn(),
            createChild: vi.fn(),
          },
      send,
    )
    return null
  }
  act(() => root.render(<Harness />))
  act(() => flow.setMode('child'))
  act(() => root.render(<Harness replies />))
  expect(flow.mode).toBe('current')
  await act(() => flow.submit('Reply'))
  expect(send).toHaveBeenCalledWith('Reply', [])
})
