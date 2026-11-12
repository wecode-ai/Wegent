import { act, createRef, useState, type RefObject } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { createCollaborationTranslator, type SharedWorkspaceApi } from '@wegent/collaboration'
import type { ComposerInputHandle } from '@wegent/collaboration/composer'
import { GroupMessageComposer, type GroupMessageComposerProps } from './GroupMessageComposer'
import type { GroupReplyTarget } from './groupReply'
import type { ThreadAgentCandidate } from './useThreadAgentCandidates'

const owner = 'account/group/thread'
const target: GroupReplyTarget = {
  scopeKey: owner,
  messageId: 'original',
  senderName: '林悦',
  content: '已有的讨论内容',
}
const nextTarget: GroupReplyTarget = { ...target, messageId: 'other', content: '另一条讨论' }

function Harness({
  scopeKey,
  initialReply,
  input,
  api,
  send,
  cancel,
  agents = [],
}: {
  scopeKey: string
  initialReply: boolean
  input: RefObject<ComposerInputHandle | null>
  api: SharedWorkspaceApi
  send: GroupMessageComposerProps['onSend']
  cancel(target: GroupReplyTarget): void
  agents?: ThreadAgentCandidate[]
}) {
  const [reply, setReply] = useState(initialReply ? target : null)
  return (
    <>
      <button data-testid="select-other-reply" onClick={() => setReply(nextTarget)}>
        Select another readable message
      </button>
      <GroupMessageComposer
        scopeKey={scopeKey}
        threadId="thread"
        members={[{ user_id: 8, name: '成员八', role: 'Developer' }]}
        agents={agents}
        currentUserId="7"
        api={api}
        inputRef={input}
        translate={createCollaborationTranslator('zh-CN')}
        replyTarget={reply}
        onCancelReply={selected => {
          cancel(selected)
          setReply(current => (current === selected ? null : current))
        }}
        onSend={send}
      />
    </>
  )
}

function setup(
  reply = false,
  send = vi.fn().mockResolvedValue(undefined),
  agents: ThreadAgentCandidate[] = []
) {
  const input = createRef<ComposerInputHandle>()
  const cancel = vi.fn()
  const upload = vi.fn().mockResolvedValue({
    id: 'attachment',
    display_name: 'review.txt',
    markdown: '[review.txt](wegent://attachments/attachment)',
  })
  const remove = vi.fn().mockResolvedValue(undefined)
  const api = { attachments: { upload, remove } } as unknown as SharedWorkspaceApi
  const props = { input, api, send, cancel, agents, initialReply: reply }
  const view = render(<Harness {...props} scopeKey={owner} />)
  const write = async (value: string) => {
    await act(async () => {
      input.current!.setValue(value)
      input.current!.focus()
      fireEvent.keyUp(screen.getByTestId('group-message-input'), { key: value.at(-1) ?? '' })
    })
  }
  const chooseMention = async () => {
    await write('@')
    fireEvent.click(await screen.findByTestId('collaboration-issue-mention-member-8'))
    await waitFor(() =>
      expect(
        screen
          .getByTestId('group-message-input')
          .querySelector('[data-composer-reference-kind="member"]')
      ).not.toBeNull()
    )
  }
  return {
    input,
    cancel,
    upload,
    remove,
    send,
    write,
    chooseMention,
    changeScope: () => view.rerender(<Harness {...props} scopeKey="next-account/group/thread" />),
  }
}

describe('Group reply composer with the real shared editor', () => {
  it.each([false, true])(
    'sends a plain @name with structured mentions in root/reply mode (reply=%s)',
    async reply => {
      const { send, input, cancel, chooseMention } = setup(reply)
      await chooseMention()
      fireEvent.click(screen.getByTestId('group-message-send'))
      await waitFor(() =>
        expect(send).toHaveBeenCalledWith('@成员八', reply ? 'original' : undefined, [
          { type: 'user', id: '8', label: '成员八' },
        ])
      )
      await waitFor(() => expect(input.current!.getValue()).toBe(''))
      if (reply) {
        expect(cancel).toHaveBeenCalledWith(target)
        expect(screen.queryByTestId('group-reply-context')).not.toBeInTheDocument()
      } else expect(cancel).not.toHaveBeenCalled()
    }
  )

  it.each(['group', 'project'] as const)(
    'sends the exact %s Agent binding with a source-labelled mention',
    async source => {
      const send = vi.fn().mockResolvedValue(undefined)
      const agents: ThreadAgentCandidate[] = [
        { id: 'group-agent', name: '同名智能体', source: { kind: 'group' } },
        { id: 'project-agent', name: '同名智能体', source: { kind: 'project', name: 'Plan' } },
      ]
      const { write } = setup(false, send, agents)
      await write('@')
      expect(
        await screen.findByTestId('collaboration-issue-mention-agent-group-agent')
      ).toHaveTextContent('来自本群')
      expect(
        screen.getByTestId('collaboration-issue-mention-agent-project-agent')
      ).toHaveTextContent('来自项目：Plan')
      fireEvent.click(screen.getByTestId(`collaboration-issue-mention-agent-${source}-agent`))
      fireEvent.click(screen.getByTestId('group-message-send'))
      await waitFor(() =>
        expect(send).toHaveBeenCalledWith('@同名智能体', undefined, [
          { type: 'agent', id: `${source}-agent`, label: '同名智能体' },
        ])
      )
    }
  )

  it('keeps the reference, text and uploaded file after failure and clears them only after success', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(undefined)
    const { input, cancel, upload, write } = setup(true, send)
    await write('补充讨论')
    fireEvent.change(screen.getByTestId('group-message-file'), {
      target: { files: [new File(['review'], 'review.txt', { type: 'text/plain' })] },
    })
    await screen.findByTestId('cloud-task-activity-card-attachment-thread-attachment')
    expect(upload).toHaveBeenCalledWith('thread', expect.any(File))
    fireEvent.click(screen.getByTestId('group-message-send'))
    expect(await screen.findByTestId('group-message-error')).toHaveTextContent('Offline')
    expect(screen.getByTestId('group-reply-context')).toHaveTextContent(target.content)
    expect(input.current!.getValue()).toContain('补充讨论')
    expect(
      screen.getByTestId('cloud-task-activity-card-attachment-thread-attachment')
    ).toBeVisible()
    expect(cancel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('group-message-send'))
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(target))
    expect(screen.queryByTestId('group-reply-context')).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('cloud-task-activity-card-attachment-thread-attachment')
    ).not.toBeInTheDocument()
    expect(input.current!.getValue()).toBe('')
  })

  it('cancels only the reference and keeps the selected mention as a root-message draft', async () => {
    const { input, send, chooseMention } = setup(true)
    await chooseMention()
    const draft = input.current!.getValue()
    fireEvent.click(screen.getByTestId('group-reply-cancel'))
    expect(screen.queryByTestId('group-reply-context')).not.toBeInTheDocument()
    expect(input.current!.getValue()).toBe(draft)
    fireEvent.click(screen.getByTestId('group-message-send'))
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('@成员八', undefined, [
        { type: 'user', id: '8', label: '成员八' },
      ])
    )
  })

  it('does not clear a newer reply target when an older send finishes', async () => {
    let finish!: () => void
    const send = vi.fn().mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    const { cancel, write } = setup(true, send)
    await write('发送中的回复')
    fireEvent.click(screen.getByTestId('group-message-send'))
    await waitFor(() => expect(send).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByTestId('select-other-reply'))
    expect(screen.getByTestId('group-reply-context')).toHaveTextContent(nextTarget.content)
    await act(async () => finish())
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(target))
    expect(screen.getByTestId('group-reply-context')).toHaveTextContent(nextTarget.content)
  })

  it('clears editor and attachment state and ignores an old quote after changing owner scope', async () => {
    const { input, send, write, changeScope } = setup(true)
    await write('旧账号草稿')
    fireEvent.change(screen.getByTestId('group-message-file'), {
      target: { files: [new File(['review'], 'review.txt', { type: 'text/plain' })] },
    })
    await screen.findByTestId('cloud-task-activity-card-attachment-thread-attachment')
    changeScope()
    expect(screen.queryByTestId('group-reply-context')).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('cloud-task-activity-card-attachment-thread-attachment')
    ).not.toBeInTheDocument()
    expect(input.current!.getValue()).toBe('')
    await write('新账号消息')
    fireEvent.click(screen.getByTestId('group-message-send'))
    await waitFor(() => expect(send).toHaveBeenCalledWith('新账号消息', undefined, []))
  })
})
