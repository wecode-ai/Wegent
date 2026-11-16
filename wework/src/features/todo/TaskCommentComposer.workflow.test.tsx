import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  IssueMainCommentComposer,
  createCollaborationTranslator,
  type CommentIssueActions,
} from '@wegent/collaboration'

function setup({ body = '请安排验收', closed = false, canToggle = true, childOnly = false } = {}) {
  const send = vi.fn().mockResolvedValue(true)
  const assign = vi.fn().mockResolvedValue(undefined)
  const move = vi.fn().mockResolvedValue(undefined)
  const toggle = vi.fn().mockResolvedValue(undefined)
  const createChild = vi.fn().mockResolvedValue({ id: 'child' })
  const actions: CommentIssueActions = {
    moves: [{ value: 'review', label: '待验收', group: '标签泳道' }],
    boardName: '研发看板',
    currentColumns: ['开发中'],
    closed,
    canToggle,
    move,
    toggle,
  }
  function Harness() {
    const [draft, setDraft] = useState(body)
    return (
      <IssueMainCommentComposer
        value={draft}
        onChange={setDraft}
        onSubmit={async (...args) => {
          const result = await send(...args)
          if (result) setDraft('')
          return result
        }}
        disabled={false}
        sending={false}
        uploading={false}
        assignment={{
          options: [{ value: '2', label: '小李' }],
          assign,
          ...(childOnly ? { canAssignCurrent: false, createChild } : {}),
        }}
        issueActions={actions}
        translate={createCollaborationTranslator('zh-CN')}
        labels={{ placeholder: '输入评论', send: '发送评论', attach: '附件', settings: '设置' }}
      />
    )
  }
  render(<Harness />)
  const pick = async (kind: 'move' | 'assignee', value: string) => {
    await userEvent.click(screen.getByTestId(`task-comment-form-${kind}`))
    await userEvent.click(screen.getByTestId(`task-comment-form-${kind}-option-${value}`))
  }
  const openSendMenu = () => userEvent.click(screen.getByTestId('task-comment-form-send-actions'))
  return { send, assign, move, toggle, pick, openSendMenu, createChild }
}

describe('Issue comment staged workflow', () => {
  it('keeps lifecycle actions in the send menu and ordinary sending never closes', async () => {
    const { send, toggle } = setup()
    expect(screen.queryByTestId('task-comment-form-close')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('send-message-button'))
    await waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith('请安排验收', []))
    expect(toggle).not.toHaveBeenCalled()
  })

  it('can close an editable Issue even when assigning the parent is forbidden', async () => {
    const { toggle, assign, createChild, openSendMenu } = setup({ childOnly: true })
    await openSendMenu()
    await userEvent.click(screen.getByTestId('task-comment-form-close'))
    await waitFor(() => expect(toggle).toHaveBeenCalledWith(true))
    expect(assign).not.toHaveBeenCalled()
    expect(createChild).not.toHaveBeenCalled()
  })
  it('stages and cancels changes without sending, assigning or moving', async () => {
    const { send, assign, move, pick } = setup()
    await pick('assignee', '2')
    await pick('move', 'review')
    expect(screen.getByTestId('send-message-button')).toHaveTextContent('发送并更新')
    expect(send).not.toHaveBeenCalled()
    expect(assign).not.toHaveBeenCalled()
    expect(move).not.toHaveBeenCalled()
    expect(screen.queryByText('评论、分配和移动将一并提交')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('task-comment-form-move-clear'))
    await userEvent.click(screen.getByTestId('task-comment-form-assignee-clear'))
    expect(screen.getByTestId('send-message-button')).toHaveTextContent('发送评论')
  })

  it('submits the comment once, then performs the selected assignment and lane change', async () => {
    const { send, assign, move, pick } = setup()
    await pick('assignee', '2')
    await pick('move', 'review')
    await userEvent.click(screen.getByTestId('send-message-button'))
    await waitFor(() => expect(move).toHaveBeenCalledWith('review'))
    expect(send).toHaveBeenCalledExactlyOnceWith('请安排验收', [], { commentOnly: true })
    expect(assign).toHaveBeenCalledExactlyOnceWith('2')
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(assign.mock.invocationCallOrder[0])
    expect(assign.mock.invocationCallOrder[0]).toBeLessThan(move.mock.invocationCallOrder[0])
    expect(screen.getByTestId('task-comment-form-assignee')).toHaveAttribute('data-value', '')
    expect(screen.getByTestId('task-comment-form-move')).toHaveAttribute('data-value', '')
  })

  it('can move without an empty comment', async () => {
    const { send, move, pick } = setup({ body: '' })
    await pick('move', 'review')
    expect(screen.getByTestId('send-message-button')).toHaveTextContent('更新事项')
    await userEvent.click(screen.getByTestId('send-message-button'))
    await waitFor(() => expect(move).toHaveBeenCalledWith('review'))
    expect(send).not.toHaveBeenCalled()
  })

  it('retains draft and selections when comment persistence fails', async () => {
    const { send, move, pick } = setup()
    send.mockResolvedValue(false)
    await pick('move', 'review')
    await userEvent.click(screen.getByTestId('send-message-button'))
    await waitFor(() => expect(send).toHaveBeenCalled())
    expect(move).not.toHaveBeenCalled()
    expect(screen.getByTestId('cloud-task-activity-composer')).toHaveValue('请安排验收')
    expect(screen.getByTestId('task-comment-form-move')).toHaveAttribute('data-value', 'review')
  })

  it('retries a failed move without duplicating the saved comment or assignment', async () => {
    const { send, assign, move, pick } = setup()
    move.mockRejectedValueOnce(new Error('连接失败'))
    await pick('assignee', '2')
    await pick('move', 'review')
    await userEvent.click(screen.getByTestId('send-message-button'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('评论已发送'))
    expect(screen.getByTestId('send-message-button')).toHaveTextContent('更新事项')
    await userEvent.click(screen.getByTestId('send-message-button'))
    await waitFor(() => expect(move).toHaveBeenCalledTimes(2))
    expect(send).toHaveBeenCalledOnce()
    expect(assign).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('closes with its comment and retries only closure after a partial failure', async () => {
    const { send, toggle, openSendMenu } = setup()
    toggle.mockRejectedValueOnce(new Error('连接失败'))
    await openSendMenu()
    await userEvent.click(screen.getByTestId('task-comment-form-close'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('评论已发送'))
    await userEvent.click(screen.getByTestId('send-message-button'))
    await waitFor(() => expect(toggle).toHaveBeenCalledTimes(2))
    expect(toggle).toHaveBeenLastCalledWith(true)
    expect(send).toHaveBeenCalledExactlyOnceWith('请安排验收', [], { commentOnly: true })
  })

  it.each([false, true])('closes/reopens an empty draft, closed=%s', async closed => {
    const { send, toggle, openSendMenu } = setup({ body: '', closed })
    await openSendMenu()
    const button = screen.getByTestId('task-comment-form-close')
    expect(button).toHaveTextContent(closed ? '重新打开' : '关闭事项')
    await userEvent.click(button)
    await waitFor(() => expect(toggle).toHaveBeenCalledWith(!closed))
    expect(send).not.toHaveBeenCalled()
  })

  it('does not offer lifecycle edits without permission and never closes on ordinary submit', async () => {
    const { send, toggle } = setup({ canToggle: false })
    expect(screen.queryByTestId('task-comment-form-close')).not.toBeInTheDocument()
    fireEvent.submit(screen.getByTestId('task-comment-form'))
    await waitFor(() => expect(send).toHaveBeenCalled())
    expect(toggle).not.toHaveBeenCalled()
  })
})
