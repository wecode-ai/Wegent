import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  IssueMainCommentComposer,
  createCollaborationTranslator,
  type CommentAssignment,
  type CommentIssueActions,
} from '@wegent/collaboration'

const defaultOptions = [
  { value: '2', label: 'User 2' },
  { value: '3', label: 'User 3' },
]

function setup({
  body = '请安排验收',
  closed = false,
  canToggle = true,
  childOnly = false,
  withIssueActions = true,
  shortcuts = undefined as CommentAssignment['shortcuts'],
  options = defaultOptions as CommentAssignment['options'],
} = {}) {
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
  function Harness({ options, shortcuts }: Pick<CommentAssignment, 'options' | 'shortcuts'>) {
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
          options,
          assign,
          shortcuts,
          ...(childOnly ? { canAssignCurrent: false, createChild } : {}),
        }}
        issueActions={withIssueActions ? actions : undefined}
        translate={createCollaborationTranslator('zh-CN')}
        labels={{ placeholder: '输入评论', send: '发送评论', attach: '附件', settings: '设置' }}
      />
    )
  }
  const { rerender } = render(<Harness options={options} shortcuts={shortcuts} />)
  const refresh = (
    nextOptions: CommentAssignment['options'],
    nextShortcuts: CommentAssignment['shortcuts']
  ) => rerender(<Harness options={nextOptions} shortcuts={nextShortcuts} />)
  const pick = async (kind: 'move' | 'assignee', value: string) => {
    await userEvent.click(screen.getByTestId(`task-comment-form-${kind}`))
    await userEvent.click(screen.getByTestId(`task-comment-form-${kind}-option-${value}`))
  }
  const openSendMenu = () => userEvent.click(screen.getByTestId('task-comment-form-send-actions'))
  return {
    send,
    assign,
    move,
    toggle,
    pick,
    openSendMenu,
    createChild,
    refresh,
  }
}

describe('Issue comment staged workflow', () => {
  it('names the editor and action pickers with their visible prompts', () => {
    setup()
    expect(screen.getByRole('textbox', { name: '输入评论' })).toBeVisible()
    expect(screen.getByTestId('task-comment-form-assignee')).toHaveAccessibleName('分配给…')
    expect(screen.getByTestId('task-comment-form-move')).toHaveAccessibleName('移动泳道…')
  })

  it('keeps lifecycle actions in the send menu and ordinary sending never closes', async () => {
    const { send, toggle } = setup()
    const button = screen.getByTestId('send-message-button')
    const options = screen.getByTestId('task-comment-form-send-actions')
    const group = button.closest('[data-composer-send-group]')
    expect(group).toContainElement(options)
    expect(button.compareDocumentPosition(options) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByTestId('task-comment-form-close')).not.toBeInTheDocument()
    await userEvent.click(button)
    await waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith('请安排验收', []))
    expect(toggle).not.toHaveBeenCalled()
  })

  it('can close an editable Issue even when assigning the parent is forbidden', async () => {
    const { send, toggle, assign, createChild, openSendMenu } = setup({ childOnly: true })
    await openSendMenu()
    await userEvent.click(screen.getByTestId('task-comment-form-close'))
    expect(send).not.toHaveBeenCalled()
    expect(toggle).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('send-message-button'))
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

  it.each([
    {
      label: 'stale redeliver shortcut',
      withIssueActions: true,
      initialShortcuts: [
        { kind: 'redeliver', value: 'redeliver:user:2', target: 'user:2', label: 'User 2' },
      ] as CommentAssignment['shortcuts'],
      selectInitial: 'task-comment-form-assignee-redeliver',
      nextOptions: defaultOptions,
      nextShortcuts: [
        { kind: 'redeliver', value: 'redeliver:user:3', target: 'user:3', label: 'User 3' },
      ] as CommentAssignment['shortcuts'],
      selectNext: 'task-comment-form-assignee-redeliver',
      expectedLabel: 'User 3',
      expectedAssigned: 'redeliver:user:3',
    },
    {
      label: 'round-tripped return shortcut with the same previous assignee',
      withIssueActions: true,
      initialShortcuts: [
        {
          kind: 'return',
          value: 'return:user:2',
          target: 'user:2',
          currentTarget: 'user:3',
          historyIndex: 0,
          label: '转回给 User 2',
        },
      ] as CommentAssignment['shortcuts'],
      selectInitial: 'task-comment-form-assignee-return',
      nextOptions: defaultOptions,
      nextShortcuts: [
        {
          kind: 'return',
          value: 'return:user:2',
          target: 'user:2',
          currentTarget: 'user:3',
          historyIndex: 2,
          label: '转回给 User 2',
        },
      ] as CommentAssignment['shortcuts'],
      selectNext: 'task-comment-form-assignee-return',
      expectedLabel: '转回给 User 2',
      expectedAssigned: 'return:user:2',
    },
    {
      label: 'removed recent assignee',
      withIssueActions: true,
      initialShortcuts: [
        { kind: 'recent', value: 'recent:user:2', target: 'user:2', label: 'User 2' },
      ] as CommentAssignment['shortcuts'],
      selectInitial: 'task-comment-form-assignee-option-2',
      nextOptions: [defaultOptions[1]],
      nextShortcuts: [] as CommentAssignment['shortcuts'],
      selectNext: 'task-comment-form-assignee-option-3',
      expectedLabel: 'User 3',
      expectedAssigned: '3',
    },
    {
      label: 'disabled ordinary assignee without workflow actions',
      withIssueActions: false,
      initialShortcuts: undefined,
      selectInitial: 'task-comment-form-assignee-option-2',
      nextOptions: [{ ...defaultOptions[0], disabled: true }, defaultOptions[1]],
      nextShortcuts: undefined,
      selectNext: 'task-comment-form-assignee-option-3',
      expectedLabel: 'User 3',
      expectedAssigned: '3',
    },
  ])(
    'requires reselection before sending when a staged target becomes invalid ($label)',
    async ({
      withIssueActions,
      initialShortcuts,
      selectInitial,
      nextOptions,
      nextShortcuts,
      selectNext,
      expectedLabel,
      expectedAssigned,
    }) => {
      const { send, assign, move, pick, refresh } = setup({
        withIssueActions,
        shortcuts: initialShortcuts,
      })
      const picker = () => screen.getByTestId('task-comment-form-assignee')
      const submit = () => screen.getByTestId('send-message-button')
      await userEvent.click(picker())
      await userEvent.click(screen.getByTestId(selectInitial))
      if (withIssueActions) await pick('move', 'review')
      expect(picker()).toHaveTextContent('User 2')
      expect(submit()).toBeEnabled()

      refresh(nextOptions, nextShortcuts)
      expect(picker()).toHaveTextContent('重新选择负责人')
      expect(picker()).toHaveAttribute('title', '重新选择负责人')
      expect(picker()).toHaveAccessibleName(/重新选择负责人/)
      expect(submit()).toBeDisabled()
      fireEvent.submit(screen.getByTestId('task-comment-form'))
      expect(send).not.toHaveBeenCalled()
      expect(move).not.toHaveBeenCalled()
      expect(assign).not.toHaveBeenCalled()

      await userEvent.click(picker())
      await userEvent.click(screen.getByTestId(selectNext))
      expect(picker()).toHaveTextContent(expectedLabel)
      expect(submit()).toBeEnabled()
      await userEvent.click(submit())
      await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith(expectedAssigned))
      expect(send).toHaveBeenCalledOnce()
      expect(move).toHaveBeenCalledTimes(withIssueActions ? 1 : 0)
    }
  )

  it('submits the comment and lane change before dispatching the selected assignment', async () => {
    const { send, assign, move, pick } = setup()
    await pick('assignee', '2')
    await pick('move', 'review')
    await userEvent.click(screen.getByTestId('send-message-button'))
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith('2'))
    expect(send).toHaveBeenCalledExactlyOnceWith('请安排验收', [], { commentOnly: true })
    expect(move).toHaveBeenCalledExactlyOnceWith('review')
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(move.mock.invocationCallOrder[0])
    expect(move.mock.invocationCallOrder[0]).toBeLessThan(assign.mock.invocationCallOrder[0])
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

  it('can cancel staged changes from the pickers as well as their clear controls', async () => {
    const { send, assign, move, pick } = setup()
    await pick('assignee', '2')
    await pick('move', 'review')
    await pick('assignee', 'empty')
    await pick('move', 'empty')
    expect(screen.getByTestId('task-comment-form-assignee')).toHaveAttribute('data-value', '')
    expect(screen.getByTestId('task-comment-form-move')).toHaveAttribute('data-value', '')
    expect(screen.getByTestId('send-message-button')).toHaveTextContent('发送评论')
    expect(send).not.toHaveBeenCalled()
    expect(assign).not.toHaveBeenCalled()
    expect(move).not.toHaveBeenCalled()
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

  it('retries a failed move without duplicating the saved comment or dispatching prematurely', async () => {
    const { send, assign, move, pick } = setup()
    move.mockRejectedValueOnce(new Error('连接失败'))
    await pick('assignee', '2')
    await pick('move', 'review')
    await userEvent.click(screen.getByTestId('send-message-button'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('评论已发送'))
    expect(assign).not.toHaveBeenCalled()
    expect(screen.getByTestId('send-message-button')).toHaveTextContent('更新事项')
    await userEvent.click(screen.getByTestId('send-message-button'))
    await waitFor(() => expect(assign).toHaveBeenCalledOnce())
    expect(move).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledOnce()
    expect(move.mock.invocationCallOrder[1]).toBeLessThan(assign.mock.invocationCallOrder[0])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('retries closure after a partial failure and dispatches only after closure succeeds', async () => {
    const { send, assign, move, toggle, pick, openSendMenu } = setup()
    toggle.mockRejectedValueOnce(new Error('连接失败'))
    await pick('assignee', '2')
    await pick('move', 'review')
    await openSendMenu()
    await userEvent.click(screen.getByTestId('task-comment-form-close'))
    expect(send).not.toHaveBeenCalled()
    expect(toggle).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('send-message-button'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('评论已发送'))
    expect(assign).not.toHaveBeenCalled()
    expect(move).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByTestId('send-message-button'))
    await waitFor(() => expect(assign).toHaveBeenCalledOnce())
    expect(move).toHaveBeenCalledOnce()
    expect(toggle).toHaveBeenCalledTimes(2)
    expect(toggle).toHaveBeenLastCalledWith(true)
    expect(send).toHaveBeenCalledExactlyOnceWith('请安排验收', [], { commentOnly: true })
    expect(toggle.mock.invocationCallOrder[1]).toBeLessThan(assign.mock.invocationCallOrder[0])
  })

  it('does not close an Issue without a comment', async () => {
    const { send, toggle, openSendMenu } = setup({ body: '' })
    await openSendMenu()
    const button = screen.getByTestId('task-comment-form-close')
    expect(button).toHaveTextContent('评论并关闭')
    await userEvent.click(button)
    expect(screen.getByTestId('send-message-button')).toBeDisabled()
    expect(send).not.toHaveBeenCalled()
    expect(toggle).not.toHaveBeenCalled()
  })

  it('stages normal commenting when switching away from closing', async () => {
    const { send, toggle, openSendMenu } = setup()
    const button = screen.getByTestId('send-message-button')
    const sendGroup = button.closest('[data-composer-send-group]')
    const menu = screen.getByTestId('task-comment-form-send-actions')
    expect(sendGroup).toContainElement(menu)
    expect(button.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(sendGroup).not.toHaveAttribute('data-selected')
    expect(button.querySelector('svg')).toHaveClass('lucide-arrow-up')
    await openSendMenu()
    const commentOption = screen.getByTestId('task-comment-form-send-option')
    const closeOption = screen.getByTestId('task-comment-form-close')
    expect(commentOption.querySelector('svg')).toHaveClass('lucide-arrow-up')
    expect(commentOption).toHaveAttribute('aria-current', 'true')
    expect(closeOption.querySelector('svg')).toHaveClass('lucide-circle-check')
    expect(closeOption).not.toHaveAttribute('aria-current')
    await userEvent.click(closeOption)
    expect(button).toHaveAccessibleName('评论并关闭')
    expect(button.querySelector('svg')).toHaveClass('lucide-circle-check')
    expect(sendGroup).toHaveAttribute('data-selected', 'true')
    await openSendMenu()
    const comment = screen.getByTestId('task-comment-form-send-option')
    expect(comment).toHaveTextContent('评论')
    expect(comment).not.toHaveAttribute('aria-current')
    expect(screen.getByTestId('task-comment-form-close')).toHaveAttribute('aria-current', 'true')
    await userEvent.click(comment)
    expect(button.querySelector('svg')).toHaveClass('lucide-arrow-up')
    expect(sendGroup).not.toHaveAttribute('data-selected')
    expect(send).not.toHaveBeenCalled()
    expect(toggle).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('send-message-button'))
    await waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith('请安排验收', []))
    expect(toggle).not.toHaveBeenCalled()
  })

  it('keeps ordinary commenting available when the Issue is closed', async () => {
    const { send, toggle } = setup({ closed: true })
    expect(screen.queryByTestId('task-comment-form-send-actions')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('send-message-button'))
    await waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith('请安排验收', []))
    expect(toggle).not.toHaveBeenCalled()
  })

  it('does not offer lifecycle edits without permission and never closes on ordinary submit', async () => {
    const { send, toggle } = setup({ canToggle: false })
    expect(screen.queryByTestId('task-comment-form-close')).not.toBeInTheDocument()
    fireEvent.submit(screen.getByTestId('task-comment-form'))
    await waitFor(() => expect(send).toHaveBeenCalled())
    expect(toggle).not.toHaveBeenCalled()
  })
})
