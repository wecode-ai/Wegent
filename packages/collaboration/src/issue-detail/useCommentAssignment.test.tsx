// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCommentAssignment } from './useCommentAssignment'
import type { CommentIssueActions } from './issueCommentActions'
import type { CommentAssignment } from './useCommentAssignment'

const mention = (id: number) => `[$@User ${id}](wework-member://${id})`
const defaultOptions = [
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
  let actions: CommentIssueActions | undefined
  let createChild: CommentAssignment['createChild']
  let shortcuts: CommentAssignment['shortcuts']
  let options: CommentAssignment['options']
  let assignmentBusy: boolean
  let assignmentSuccessRevision: number
  const assign = vi.fn<(id: string) => Promise<void | boolean>>()
  const send = vi.fn<() => Promise<boolean>>()
  function Harness() {
    transfer = useCommentAssignment(
      draft,
      enabled
        ? { options, assign, createChild, shortcuts, assignmentBusy, assignmentSuccessRevision }
        : undefined,
      send,
      actions
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
    actions = undefined
    createChild = undefined
    shortcuts = undefined
    options = defaultOptions
    assignmentBusy = false
    assignmentSuccessRevision = 0
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

  it('does not suggest a disabled member even when the mention was focused previously', () => {
    render(`${mention(1)} ${mention(2)}`)
    act(() => transfer.suggestReference(mention(1)))
    expect(transfer.suggestion?.value).toBe('1')
    options = options.map(option => (option.value === '1' ? { ...option, disabled: true } : option))
    render(`${mention(1)} ${mention(2)}`)
    expect(transfer.suggestion?.value).toBe('2')
    expect(transfer.suggestReference(mention(1))).toBe(false)
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

  it.each(['redeliver', 'return'] as const)(
    'keeps a selected %s action when a mention already names the same assignee',
    async kind => {
      const value = `${kind}:user:1` as const
      shortcuts = [{ kind, value, target: 'user:1', label: 'User 1' }]
      render(mention(1))
      act(() => transfer.setTarget(value))
      expect(transfer.suggestion).toBeUndefined()
      act(() => transfer.suggestReference(mention(1)))
      expect(transfer.suggestion).toBeUndefined()

      render(mention(2))
      expect(transfer.suggestion?.value).toBe('2')
      expect(transfer.target).toBe(value)
      await act(() => transfer.submit(draft))
      expect(assign).toHaveBeenCalledExactlyOnceWith(value)
    }
  )

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
    expect(send).toHaveBeenCalledWith('@User 1', [{ type: 'user', id: '1', label: 'User 1' }])
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
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(assign.mock.invocationCallOrder[0])
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

  it.each(['assignment', 'assignee move', 'move', 'close'] as const)(
    'clears only stale assignment errors after another entry succeeds (%s failure)',
    async stage => {
      const message = 'Operation unavailable'
      const move = vi.fn().mockResolvedValue(undefined)
      const toggle = vi.fn().mockResolvedValue(undefined)
      const assigneeMove = stage === 'assignee move' || stage === 'close'
      if (stage === 'assignment') assign.mockRejectedValueOnce(new Error(message))
      else if (stage === 'close') toggle.mockRejectedValueOnce(new Error(message))
      else move.mockRejectedValueOnce(new Error(message))
      actions = {
        moves: [],
        assigneeMoves: assigneeMove ? ['review'] : [],
        boardName: 'Board',
        currentColumns: [],
        closed: false,
        canToggle: true,
        move,
        toggle,
      }
      render('Please review')
      act(() => {
        if (!assigneeMove) transfer.setTarget('1')
        if (stage !== 'assignment') transfer.setMove('review')
        if (stage === 'close') transfer.selectCloseWithComment(true)
      })
      await act(() => transfer.submit(draft))
      expect(transfer.error).toBe(message)
      expect(transfer.commentCommitted).toBe(true)

      assignmentSuccessRevision++
      render(draft)
      expect(transfer.error).toBe(
        stage === 'assignment' || stage === 'assignee move' ? null : message
      )
      expect(transfer.target).toBe(assigneeMove ? '' : '1')
      expect(transfer.moveTarget).toBe(
        stage === 'move' || stage === 'assignee move' ? 'review' : ''
      )
      expect(transfer.commentCommitted).toBe(true)
      await act(() => transfer.submit(draft))
      expect(send).toHaveBeenCalledOnce()
      expect(transfer.target).toBe('')
      expect(transfer.error).toBeNull()
    }
  )

  it('requires reselection of stale shortcuts and unavailable assignees without blocking empty targets', async () => {
    options = []
    render('Ordinary comment')
    expect(transfer.invalidTarget).toBe(false)
    options = defaultOptions

    shortcuts = [
      { kind: 'redeliver', value: 'redeliver:user:1', target: 'user:1', label: 'User 1' },
    ]
    assign.mockRejectedValueOnce(new Error('Assignee changed'))
    render('Please review')
    act(() => transfer.setTarget('redeliver:user:1'))
    await act(() => transfer.submit(draft))
    expect(transfer.commentCommitted).toBe(true)

    shortcuts = [
      { kind: 'redeliver', value: 'redeliver:user:2', target: 'user:2', label: 'User 2' },
    ]
    render('Please review')
    expect(transfer.invalidTarget).toBe(true)
    await act(() => transfer.submit(draft))
    expect(send).toHaveBeenCalledOnce()
    expect(assign).toHaveBeenCalledExactlyOnceWith('redeliver:user:1')

    act(() => transfer.setTarget('redeliver:user:2'))
    expect(transfer.invalidTarget).toBe(false)
    await act(() => transfer.submit(draft))
    expect(send).toHaveBeenCalledOnce()
    expect(assign).toHaveBeenNthCalledWith(2, 'redeliver:user:2')
    expect(transfer.target).toBe('')
    expect(transfer.commentCommitted).toBe(false)
  })

  it('preserves a cancelled invitation and retries without duplicating its saved comment', async () => {
    assign.mockResolvedValueOnce(false).mockResolvedValueOnce(undefined)
    render(mention(1))
    act(() => transfer.acceptSuggestion())
    await act(() => transfer.submit(draft))
    expect(transfer.target).toBe('1')
    expect(transfer.error).toBeNull()
    await act(() => transfer.submit(draft))
    expect(send).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledTimes(2)
    expect(transfer.target).toBe('')
  })

  it('keeps a pending assignee scoped to the selected action', () => {
    createChild = vi.fn()
    render('Create a child')
    act(() => transfer.setTarget('1'))
    act(() => transfer.setMode('child'))
    expect(transfer.target).toBe('')
    act(() => transfer.setTarget('2'))
    act(() => transfer.setMode('current'))
    expect(transfer.target).toBe('')
  })

  it('uses a newly selected child target after cancelling invitation without reposting', async () => {
    const create = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce({ id: 'child' })
    createChild = create
    render('Create a child')
    act(() => {
      transfer.setMode('child')
      transfer.setTarget('1')
    })
    await act(() => transfer.submit(draft))
    expect(transfer.childTargetLocked).toBe(false)
    act(() => transfer.setTarget('2'))
    await act(() => transfer.submit(''))
    expect(send).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenNthCalledWith(2, {
      ...create.mock.calls[0][0],
      target: '2',
    })
    expect(transfer.pendingChild).toBeNull()
  })

  it('allows reselection when the target of a pending child becomes unavailable', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('Assignment unavailable'))
      .mockResolvedValueOnce({ id: 'child' })
    createChild = create
    render('Create a child')
    act(() => {
      transfer.setMode('child')
      transfer.setTarget('1')
    })
    await act(() => transfer.submit(draft))
    expect(transfer.childTargetLocked).toBe(true)

    options = options.filter(option => option.value !== '1')
    render('')
    expect(transfer.invalidTarget).toBe(true)
    expect(transfer.childTargetLocked).toBe(false)
    await act(() => transfer.submit(''))
    expect(create).toHaveBeenCalledOnce()

    act(() => transfer.setTarget('2'))
    expect(transfer.invalidTarget).toBe(false)
    await act(() => transfer.submit(''))
    expect(send).toHaveBeenCalledOnce()
    expect(create).toHaveBeenNthCalledWith(2, {
      ...create.mock.calls[0][0],
      target: '2',
    })
    expect(transfer.pendingChild).toBeNull()
  })

  it.each(['assignee', 'lane'] as const)(
    'blocks a staged %s assignment while an Issue assignment is active but allows an ordinary comment',
    async kind => {
      const move = vi.fn()
      actions = {
        moves: [],
        assigneeMoves: ['assignee-lane'],
        boardName: 'People',
        currentColumns: [],
        closed: false,
        canToggle: true,
        move,
        toggle: vi.fn(),
      }
      render('Please review')
      act(() => {
        if (kind === 'assignee') transfer.setTarget('1')
        else transfer.setMove('assignee-lane')
      })
      assignmentBusy = true
      render(draft)
      expect(transfer.assignmentBlocked).toBe(true)
      await act(() => transfer.submit(draft))
      expect(send).not.toHaveBeenCalled()
      expect(assign).not.toHaveBeenCalled()
      expect(move).not.toHaveBeenCalled()

      act(() => {
        if (kind === 'assignee') transfer.setTarget('')
        else transfer.setMove('')
      })
      expect(transfer.assignmentBlocked).toBe(false)
      await act(() => transfer.submit(draft))
      expect(send).toHaveBeenCalledOnce()
      expect(assign).not.toHaveBeenCalled()
      expect(move).not.toHaveBeenCalled()
    }
  )

  it('prevents duplicate submissions', async () => {
    render('')
    act(() => transfer.setTarget('1'))
    await act(async () => {
      await Promise.all([transfer.submit(''), transfer.submit('')])
    })
    expect(send).not.toHaveBeenCalled()
    expect(assign).toHaveBeenCalledTimes(1)
  })

  it('can send identical text as a new comment after cancelling a failed assignment', async () => {
    assign.mockRejectedValueOnce(new Error('Assignment unavailable'))
    render('Please review')
    act(() => transfer.setTarget('1'))
    await act(() => transfer.submit(draft))
    expect(send).toHaveBeenCalledTimes(1)
    expect(transfer.commentCommitted).toBe(true)

    act(() => transfer.setTarget(''))
    await act(() => transfer.submit('Please review'))
    expect(send).toHaveBeenCalledTimes(2)
    expect(assign).toHaveBeenCalledTimes(1)
    expect(transfer.commentCommitted).toBe(false)
  })

  it.each([false, true])(
    'retains the comment receipt only while a move remains pending, cancel=%s',
    async cancel => {
      const move = vi
        .fn()
        .mockRejectedValueOnce(new Error('Move unavailable'))
        .mockResolvedValue(undefined)
      actions = {
        moves: [],
        boardName: 'Board',
        currentColumns: [],
        closed: false,
        canToggle: true,
        move,
        toggle: vi.fn(),
      }
      render('Please review')
      act(() => transfer.setMove('review'))
      await act(() => transfer.submit(draft))
      expect(send).toHaveBeenCalledTimes(1)
      expect(transfer.commentCommitted).toBe(true)
      if (cancel) act(() => transfer.setMove(''))
      await act(() => transfer.submit('Please review'))
      expect(send).toHaveBeenCalledTimes(cancel ? 2 : 1)
      expect(move).toHaveBeenCalledTimes(cancel ? 1 : 2)
    }
  )

  it('keeps a cancelled assignee move pending without reposting its comment', async () => {
    const move = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(undefined)
    actions = {
      moves: [],
      boardName: 'People',
      currentColumns: [],
      closed: false,
      canToggle: true,
      move,
      toggle: vi.fn(),
    }
    render('Transfer this')
    act(() => transfer.setMove('outside'))
    await act(() => transfer.submit(draft))
    expect(transfer.moveTarget).toBe('outside')
    expect(transfer.commentCommitted).toBe(true)
    await act(() => transfer.submit(draft))
    expect(move).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledOnce()
    expect(transfer.moveTarget).toBe('')
    expect(transfer.commentCommitted).toBe(false)
  })

  it('allows a new identical comment when cancelling a failed assignment after moving', async () => {
    const move = vi.fn().mockResolvedValue(undefined)
    actions = {
      moves: [],
      boardName: 'Board',
      currentColumns: [],
      closed: false,
      canToggle: true,
      move,
      toggle: vi.fn(),
    }
    assign.mockRejectedValueOnce(new Error('Assignment unavailable'))
    render('Please review')
    act(() => {
      transfer.setTarget('1')
      transfer.setMove('review')
    })
    await act(() => transfer.submit(draft))
    expect(transfer.moveTarget).toBe('')
    act(() => transfer.setTarget(''))
    await act(() => transfer.submit('Please review'))
    expect(send).toHaveBeenCalledTimes(2)
    expect(move).toHaveBeenCalledExactlyOnceWith('review')
  })

  it('retries a failed assignment without repeating its saved move or closure', async () => {
    const move = vi.fn().mockResolvedValue(undefined)
    const toggle = vi.fn().mockResolvedValue(undefined)
    actions = {
      moves: [],
      boardName: 'Board',
      currentColumns: [],
      closed: false,
      canToggle: true,
      move,
      toggle,
    }
    assign.mockRejectedValueOnce(new Error('Assignment unavailable'))
    render('Please review')
    act(() => {
      transfer.setTarget('1')
      transfer.setMove('review')
      transfer.selectCloseWithComment(true)
    })
    await act(() => transfer.submit(draft))
    expect(transfer.target).toBe('1')
    expect(transfer.moveTarget).toBe('')
    expect(transfer.closeWithComment).toBe(false)
    expect(move.mock.invocationCallOrder[0]).toBeLessThan(toggle.mock.invocationCallOrder[0])
    expect(toggle.mock.invocationCallOrder[0]).toBeLessThan(assign.mock.invocationCallOrder[0])
    await act(() => transfer.submit(draft))
    expect(send).toHaveBeenCalledOnce()
    expect(move).toHaveBeenCalledOnce()
    expect(toggle).toHaveBeenCalledOnce()
    expect(assign).toHaveBeenCalledTimes(2)
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
    }
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
