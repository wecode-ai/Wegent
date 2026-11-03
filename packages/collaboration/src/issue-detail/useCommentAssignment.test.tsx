// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCommentAssignment } from './useCommentAssignment'

const mention = (id: number) => `[$@User ${id}](wework-member://${id})`
const options = [
  { value: '1', label: 'User 1' },
  { value: '2', label: 'User 2' },
  { value: 'agent:bot', label: 'Robot' },
  { value: 'group:squad', label: 'Squad' },
]

describe('comment assignment', () => {
  let root: Root
  let transfer: ReturnType<typeof useCommentAssignment>
  let draft: string
  let enabled: boolean
  const assign = vi.fn<(id: string) => Promise<void>>()
  const send = vi.fn<() => Promise<boolean>>()
  function Harness() {
    transfer = useCommentAssignment(
      draft,
      enabled ? { options, assign } : undefined,
      send,
    )
    return null
  }
  function render(value: string) {
    draft = value
    act(() => root.render(<Harness />))
  }
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    root = createRoot(document.createElement('div'))
    enabled = true
    assign.mockReset().mockResolvedValue(undefined)
    send.mockReset().mockResolvedValue(true)
  })
  afterEach(() => act(() => root.unmount()))

  it('suggests the first eligible mention without filling the selector or assigning', () => {
    render(`${mention(3)} ${mention(1)} ${mention(2)}`)
    expect(transfer.suggestion?.value).toBe('1')
    expect(transfer.target).toBe('')
    render(mention(2))
    expect(transfer.suggestion?.value).toBe('2')
    render('No mentions')
    expect(transfer.suggestion).toBeUndefined()
    expect(assign).not.toHaveBeenCalled()
  })

  it('only fills the selector when accepting an agent mention', () => {
    render('[$@Robot](wework-agent://bot)')
    expect(transfer.suggestion?.value).toBe('agent:bot')
    act(() => transfer.acceptSuggestion())
    expect(transfer.target).toBe('agent:bot')
    expect(transfer.suggestion).toBeUndefined()
    expect(assign).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps manual A when mentioning B until the suggestion is accepted', () => {
    render('')
    act(() => transfer.setTarget('1'))
    render(mention(2))
    expect(transfer.target).toBe('1')
    expect(transfer.suggestion?.value).toBe('2')
    act(() => transfer.acceptSuggestion())
    expect(transfer.target).toBe('2')
    expect(assign).not.toHaveBeenCalled()
  })

  it('switches and reopens suggestions from clicked mentions without changing a manual target', () => {
    render(`${mention(1)} ${mention(2)}`)
    act(() => transfer.setTarget('group:squad'))
    act(() => transfer.suggestReference(mention(2)))
    expect(transfer.suggestion?.value).toBe('2')
    expect(transfer.target).toBe('group:squad')
    act(() => transfer.dismissSuggestion())
    expect(transfer.suggestion).toBeUndefined()
    act(() => transfer.suggestReference(mention(1)))
    expect(transfer.suggestion?.value).toBe('1')
    expect(assign).not.toHaveBeenCalled()
  })

  it('sends unaccepted mentions without assigning and preserves the suggestion after sending', async () => {
    send.mockImplementation(async () => {
      render('')
      return true
    })
    render(mention(1))
    await act(() => transfer.submit(draft))
    expect(send).toHaveBeenCalledWith('@User 1', [
      { type: 'user', id: '1', label: 'User 1' },
    ])
    expect(assign).not.toHaveBeenCalled()
    expect(transfer.target).toBe('')
    expect(transfer.suggestion?.value).toBe('1')
  })

  it('dismisses only the current suggestion and does not restore it after sending', async () => {
    send.mockImplementation(async () => {
      render('')
      return true
    })
    render(mention(1))
    act(() => transfer.dismissSuggestion())
    expect(transfer.suggestion).toBeUndefined()
    await act(() => transfer.submit(draft))
    expect(transfer.suggestion).toBeUndefined()
    expect(assign).not.toHaveBeenCalled()
    render(mention(2))
    expect(transfer.suggestion?.value).toBe('2')
  })

  it('saves the comment before submitting an explicitly selected assignee', async () => {
    send.mockImplementation(async () => {
      render('')
      return true
    })
    render(mention(1))
    act(() => transfer.acceptSuggestion())
    expect(assign).not.toHaveBeenCalled()
    await act(() => transfer.submit(draft))
    expect(assign).toHaveBeenCalledWith('1')
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(
      assign.mock.invocationCallOrder[0],
    )
    expect(transfer.target).toBe('')
    expect(transfer.suggestion).toBeUndefined()
  })

  it('does not assign when comment persistence fails', async () => {
    send.mockResolvedValue(false)
    render(mention(1))
    act(() => transfer.acceptSuggestion())
    await act(() => transfer.submit(draft))
    expect(assign).not.toHaveBeenCalled()
    expect(transfer.target).toBe('1')
  })

  it('keeps a failed assignment and retries without duplicating the saved comment', async () => {
    assign.mockRejectedValueOnce(new Error('Version conflict'))
    send.mockImplementation(async () => {
      render('')
      return true
    })
    render(mention(1))
    act(() => transfer.acceptSuggestion())
    await act(() => transfer.submit(draft))
    expect(transfer.error).toBe('Version conflict')
    expect(transfer.target).toBe('1')
    await act(() => transfer.submit(draft))
    expect(send).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledTimes(2)
    expect(transfer.error).toBeNull()
  })

  it('prevents duplicate submissions', async () => {
    render('')
    act(() => transfer.setTarget('1'))
    await act(async () => {
      await Promise.all([transfer.submit(''), transfer.submit('')])
    })
    expect(send).not.toHaveBeenCalled()
    expect(assign).toHaveBeenCalledTimes(1)
  })

  it.each(['1', 'agent:bot', 'group:squad'])(
    'submits %s without posting an empty comment',
    async target => {
      render('')
      act(() => transfer.setTarget(target))
      expect(assign).not.toHaveBeenCalled()
      await act(() => transfer.submit(''))
      expect(assign).toHaveBeenCalledWith(target)
      expect(send).not.toHaveBeenCalled()
      expect(transfer.target).toBe('')
    },
  )

  it('never suggests or selects an assignee without assignment permission', async () => {
    enabled = false
    render(mention(1))
    expect(transfer.target).toBe('')
    expect(transfer.suggestion).toBeUndefined()
    act(() => transfer.acceptSuggestion())
    expect(assign).not.toHaveBeenCalled()
  })
})
