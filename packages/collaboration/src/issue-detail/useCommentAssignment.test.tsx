// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationMember } from '../types'
import { useCommentAssignment } from './useCommentAssignment'

const mention = (id: number) => `[$@User ${id}](wework-member://${id})`
const members = [1, 2, 3].map(user_id => ({
  user_id,
  user_name: `User ${user_id}`,
  role: user_id === 3 ? 'Viewer' : 'Developer',
})) as CollaborationMember[]

describe('comment assignment', () => {
  let root: Root
  let container: HTMLDivElement
  let transfer: ReturnType<typeof useCommentAssignment>
  let draft: string
  let enabled: boolean
  const assign = vi.fn<(id: number) => Promise<void>>()
  const send = vi.fn<() => Promise<boolean>>()
  function Harness() {
    transfer = useCommentAssignment(draft, enabled ? { members, assign } : undefined, send)
    return null
  }
  function render(value: string) {
    draft = value
    act(() => root.render(<Harness />))
  }
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    root = createRoot(container)
    enabled = true
    assign.mockReset().mockResolvedValue(undefined)
    send.mockReset().mockResolvedValue(true)
  })
  afterEach(() => act(() => root.unmount()))

  it('uses the first eligible human in document order and follows mention removal', () => {
    render(`[$@Robot](wework-agent://99) ${mention(3)} ${mention(1)} ${mention(2)} ${mention(1)}`)
    expect(transfer.target).toBe('1')
    render(mention(2))
    expect(transfer.target).toBe('2')
    render('No mentions')
    expect(transfer.target).toBe('')
  })

  it('keeps manual choices, including keep-current, when mentions change', () => {
    render(mention(1))
    act(() => transfer.setTarget('2'))
    render(mention(1))
    expect(transfer.target).toBe('2')
    act(() => transfer.setTarget(''))
    render(mention(2))
    expect(transfer.target).toBe('')
  })

  it('persists the comment before assigning, then resets the manual choice', async () => {
    render('Please review')
    act(() => transfer.setTarget('2'))
    await act(() => transfer.submit(draft))
    expect(send).toHaveBeenCalledWith('Please review', [])
    expect(assign).toHaveBeenCalledWith(2)
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(assign.mock.invocationCallOrder[0])
    expect(transfer.target).toBe('')
  })

  it('does not assign when comment persistence fails', async () => {
    send.mockResolvedValue(false)
    render(mention(1))
    await act(() => transfer.submit(draft))
    expect(assign).not.toHaveBeenCalled()
    expect(transfer.target).toBe('1')
  })

  it('keeps a failed assignment so retry does not repost the persisted comment', async () => {
    assign.mockRejectedValueOnce(new Error('Version conflict'))
    send.mockImplementation(async () => {
      render('')
      return true
    })
    render(mention(1))
    await act(() => transfer.submit(draft))
    expect(transfer.error).toBe('Version conflict')
    expect(transfer.target).toBe('1')
    await act(() => transfer.submit(draft))
    expect(send).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledTimes(2)
    expect(transfer.error).toBeNull()
  })

  it('supports assignment without a comment and prevents double submission', async () => {
    render('')
    act(() => transfer.setTarget('1'))
    await act(async () => {
      await Promise.all([transfer.submit(''), transfer.submit('')])
    })
    expect(send).not.toHaveBeenCalled()
    expect(assign).toHaveBeenCalledTimes(1)
  })

  it('never selects an assignee without assignment permission', () => {
    enabled = false
    render(mention(1))
    expect(transfer.target).toBe('')
    expect(transfer.members).toEqual([])
  })
})
