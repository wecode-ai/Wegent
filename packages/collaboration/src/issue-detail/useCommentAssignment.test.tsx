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
  let container: HTMLDivElement
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
    container = document.createElement('div')
    root = createRoot(container)
    enabled = true
    assign.mockReset().mockResolvedValue(undefined)
    send.mockReset().mockResolvedValue(true)
  })
  afterEach(() => act(() => root.unmount()))

  it('suggests the first eligible mention and follows removal without assigning', () => {
    render(`${mention(3)} ${mention(1)} ${mention(2)}`)
    expect(transfer.target).toBe('1')
    render(mention(2))
    expect(transfer.target).toBe('2')
    render('No mentions')
    expect(transfer.target).toBe('')
    render('')
    expect(transfer.target).toBe('')
    expect(assign).not.toHaveBeenCalled()
  })

  it('suggests eligible agent mentions', () => {
    render('[$@Robot](wework-agent://bot)')
    expect(transfer.target).toBe('agent:bot')
    expect(assign).not.toHaveBeenCalled()
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

  it('sends a mention without assigning and preserves the suggestion after clearing the draft', async () => {
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
    expect(transfer.target).toBe('1')
    await act(() => transfer.confirm())
    expect(assign).toHaveBeenCalledWith('1')
    expect(send).toHaveBeenCalledTimes(1)
    expect(transfer.target).toBe('')
  })

  it('retains the suggestion when comment persistence fails', async () => {
    send.mockResolvedValue(false)
    render(mention(1))
    await act(() => transfer.submit(draft))
    expect(assign).not.toHaveBeenCalled()
    expect(transfer.target).toBe('1')
  })

  it('keeps a failed assignment and retries without posting any comment', async () => {
    assign.mockRejectedValueOnce(new Error('Version conflict'))
    render(mention(1))
    await act(() => transfer.confirm())
    expect(transfer.error).toBe('Version conflict')
    expect(transfer.target).toBe('1')
    await act(() => transfer.confirm())
    expect(send).not.toHaveBeenCalled()
    expect(assign).toHaveBeenCalledTimes(2)
    expect(transfer.error).toBeNull()
    expect(transfer.target).toBe('')
    expect(draft).toBe(mention(1))
  })

  it('prevents duplicate confirmations', async () => {
    render('')
    act(() => transfer.setTarget('1'))
    await act(async () => {
      await Promise.all([transfer.confirm(), transfer.confirm()])
    })
    expect(send).not.toHaveBeenCalled()
    expect(assign).toHaveBeenCalledTimes(1)
  })

  it('clears a failed assignment error when choosing a different assignee', async () => {
    assign.mockRejectedValueOnce(new Error('Version conflict'))
    render('')
    act(() => transfer.setTarget('1'))
    await act(() => transfer.confirm())
    expect(transfer.error).toBe('Version conflict')
    act(() => transfer.setTarget('2'))
    expect(transfer.error).toBeNull()
  })

  it.each(['1', 'agent:bot', 'group:squad'])(
    'confirms %s independently of an unsent draft',
    async target => {
      render('Please take over')
      act(() => transfer.setTarget(target))
      await act(() => transfer.confirm())
      expect(assign).toHaveBeenCalledWith(target)
      expect(send).not.toHaveBeenCalled()
      expect(transfer.target).toBe('')
      expect(draft).toBe('Please take over')
    },
  )

  it('never selects an assignee without assignment permission', async () => {
    enabled = false
    render(mention(1))
    expect(transfer.target).toBe('')
    await act(() => transfer.confirm())
    expect(assign).not.toHaveBeenCalled()
  })
})
