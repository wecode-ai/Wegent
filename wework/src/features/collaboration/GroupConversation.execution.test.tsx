import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectChatMessage } from '@wegent/chat-core'
import type { GroupMessageComposerProps } from './GroupMessageComposer'
import { GroupConversation } from './GroupConversation'
import { activityFixture } from './threadExecutionActivity.test-support'
import '@/i18n'

vi.mock('./GroupMessageComposer', () => ({
  GroupMessageComposer: (props: GroupMessageComposerProps) => (
    <>
      <button
        data-testid="send-group-agent"
        disabled={!props.agents?.length}
        onClick={() =>
          void props.onSend('@Group reviewer', undefined, [
            { type: 'agent', id: props.agents![0].id, label: props.agents![0].name },
          ])
        }
      >
        Send to group Agent
      </button>
      <button
        data-testid="send-human-discussion"
        onClick={() => void props.onSend('普通讨论', undefined, [])}
      >
        Discuss
      </button>
    </>
  ),
}))

function setup() {
  const fixture = activityFixture()
  fixture.item.status = 'pending'
  fixture.api.agents = {
    list: vi.fn(async () => [{ id: 'group-agent', name: 'Group reviewer', status: 'active' }]),
  } as never
  fixture.groups.projectLink = vi.fn(async () => ({
    project: null,
    restricted: false,
    thread_version: 1,
  }))
  const messages: ProjectChatMessage[] = []
  vi.mocked(fixture.chat.subscribe).mockImplementation(async () => ({
    snapshot: { currentUserId: '7', latestSequence: messages.length, messages: [...messages] },
    unsubscribe: vi.fn(),
  }))
  vi.mocked(fixture.chat.send).mockImplementation(async input => {
    const message: ProjectChatMessage = {
      ...fixture.message,
      messageId: `saved-${messages.length}`,
      content: input.text,
      sender: { id: '7', name: 'Author', type: 'user' },
      metadata: { mentions: input.mentions ?? [] },
      replyToMessageId: input.replyToMessageId,
    }
    messages.push(message)
    return message
  })
  render(
    <GroupConversation
      group={fixture.context.group}
      project={fixture.context.project}
      item={fixture.item}
      items={[fixture.item]}
      api={fixture.api}
      catalog={fixture.api}
      members={[]}
      groups={fixture.groups}
      chat={fixture.chat}
      locale="zh-CN"
      accountScope="account"
      onOpenThread={vi.fn()}
      onBack={vi.fn()}
      onChanged={vi.fn()}
      onClearFocus={vi.fn()}
    />
  )
  return fixture
}

describe('Group Thread Agent conversation integration', () => {
  it('offers its own Group Agent and admits the persisted message through the real execution port', async () => {
    const fixture = setup()
    const send = await screen.findByTestId('send-group-agent')
    await waitFor(() => expect(send).not.toBeDisabled())
    fireEvent.click(send)
    await waitFor(() =>
      expect(fixture.chat.executeTaskComment).toHaveBeenCalledExactlyOnceWith({
        projectId: 'group',
        taskId: 'T-1',
        triggerMessageId: 'saved-0',
      })
    )
    expect(fixture.api.agents.list).toHaveBeenCalledExactlyOnceWith('group', { forceRefresh: true })
    expect(fixture.chat.send).toHaveBeenCalledOnce()
  })

  it('keeps ordinary human discussion from automatically running the shared assignee', async () => {
    const fixture = setup()
    fireEvent.click(await screen.findByTestId('send-human-discussion'))
    await waitFor(() => expect(fixture.chat.send).toHaveBeenCalledOnce())
    expect(fixture.chat.executeTaskComment).not.toHaveBeenCalled()
  })

  it('retries admission of the same saved message after a runner failure without duplicate posting', async () => {
    const fixture = setup()
    vi.mocked(fixture.chat.executeTaskComment!)
      .mockRejectedValueOnce(new Error('Runner offline'))
      .mockResolvedValue([])
    const send = await screen.findByTestId('send-group-agent')
    await waitFor(() => expect(send).not.toBeDisabled())
    fireEvent.click(send)
    expect(await screen.findByRole('alert')).toHaveTextContent('Runner offline')
    fireEvent.click(screen.getByTestId('thread-comment-execution-retry'))
    await waitFor(() => expect(fixture.chat.executeTaskComment).toHaveBeenCalledTimes(2))
    expect(fixture.chat.executeTaskComment).toHaveBeenLastCalledWith({
      projectId: 'group',
      taskId: 'T-1',
      triggerMessageId: 'saved-0',
    })
    expect(fixture.chat.send).toHaveBeenCalledOnce()
  })
})
