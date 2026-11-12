import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectChatMessage } from '@wegent/chat-core'
import { executeThreadComment } from './threadCommentExecution'
import { useThreadCommentExecution } from './useThreadCommentExecution'
import { activityFixture } from './threadExecutionActivity.test-support'

vi.mock('./threadCommentExecution', () => ({ executeThreadComment: vi.fn() }))
function setup() {
  const fixture = activityFixture()
  const onMessages = vi.fn()
  const props = {
    context: fixture.context,
    groups: fixture.groups,
    chat: fixture.chat,
    active: true,
    unavailable: 'Unavailable',
    onMessages,
  }
  const view = renderHook(values => useThreadCommentExecution(values), { initialProps: props })
  return { ...fixture, ...view, props, onMessages }
}

describe('Saved-message execution admission and recovery', () => {
  it('retries the same persisted trigger without resending its discussion', async () => {
    vi.mocked(executeThreadComment)
      .mockRejectedValueOnce(new Error('Runner unavailable'))
      .mockResolvedValue([])
    const { result, message, onMessages, chat } = setup()
    await act(async () => {
      expect(await result.current.execute(message)).toBe(false)
    })
    expect(result.current.error).toBe('Runner unavailable')
    await act(async () => {
      expect(await result.current.retry()).toBe(true)
    })
    expect(executeThreadComment).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ trigger: message })
    )
    expect(chat.send).not.toHaveBeenCalled()
    expect(onMessages).toHaveBeenCalledOnce()
    expect(result.current.error).toBeNull()
  })

  it('queues both saved triggers when another admission is still pending', async () => {
    let finish!: (messages: ProjectChatMessage[]) => void
    vi.mocked(executeThreadComment)
      .mockReset()
      .mockReturnValueOnce(
        new Promise(resolve => {
          finish = resolve
        })
      )
      .mockResolvedValue([])
    const { result, message } = setup()
    let first!: Promise<boolean>
    let second!: Promise<boolean>
    act(() => {
      first = result.current.execute(message)
      second = result.current.execute({ ...message, messageId: 'second' })
    })
    await waitFor(() => expect(executeThreadComment).toHaveBeenCalledOnce())
    await act(async () => {
      finish([])
      expect(await first).toBe(true)
      expect(await second).toBe(true)
    })
    expect(executeThreadComment).toHaveBeenCalledTimes(2)
    expect(executeThreadComment).toHaveBeenLastCalledWith(
      expect.objectContaining({ trigger: expect.objectContaining({ messageId: 'second' }) })
    )
  })

  it('does not merge an old account reply or execute a queued old trigger after switching accounts', async () => {
    let finish!: (messages: ProjectChatMessage[]) => void
    vi.mocked(executeThreadComment)
      .mockReset()
      .mockReturnValueOnce(
        new Promise(resolve => {
          finish = resolve
        })
      )
    const { result, message, props, rerender, onMessages } = setup()
    let first!: Promise<boolean>
    let queued!: Promise<boolean>
    act(() => {
      first = result.current.execute(message)
      queued = result.current.execute({ ...message, messageId: 'queued' })
    })
    rerender({ ...props, context: { ...props.context, accountScope: 'another-account' } })
    await act(async () => {
      finish([message])
      expect(await first).toBe(false)
      expect(await queued).toBe(false)
    })
    expect(executeThreadComment).toHaveBeenCalledOnce()
    expect(onMessages).not.toHaveBeenCalled()
    expect(result.current.error).toBeNull()
  })
})
