import '@/i18n'
import { render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { StandInExecutorApi, StandInInboxMessage, StandInInboxWork } from '@/api/standIn'
import { StandInWorkMessages } from './StandInWorkMessages'

const source = {
  providerId: '@wegent/dsh-connection-dingtalk/dingtalk',
  profile: 'dingtalk',
  accountId: 'account-new',
  kind: 'direct',
  id: 'peer',
  name: 'Test chat',
  policy: { automatic: true, askBeforeAct: false },
}

function work(refreshVersion: string): StandInInboxWork {
  return {
    id: 'work-1',
    taskId: 'task-1',
    roleId: '@primary',
    title: 'Connected work',
    source,
    status: 'sent',
    updatedAt: '2026-01-01T00:00:00Z',
    refreshVersion,
    messageCount: 1,
    latestMessage: null,
  }
}

function message(text: string): StandInInboxMessage {
  return {
    id: 'message-1',
    recordId: 'record-1',
    text,
    senderId: 'peer',
    at: '2026-01-01T00:00:00Z',
    source,
  }
}

it('refreshes an expanded detail when visible message state changes without count or time changes', async () => {
  let response = { messages: [message('Earlier source details')] }
  const workMessages = vi.fn<StandInExecutorApi['workMessages']>(async () => response)
  const api = { workMessages } as unknown as StandInExecutorApi
  const onExpandedChange = vi.fn()
  const onDrag = vi.fn()
  const onDragEnd = vi.fn()
  const onChooseTarget = vi.fn()
  const onOrganize = vi.fn(async () => {})
  const firstWork = work('version-1')
  const props = {
    api,
    userId: 7,
    deviceId: 'mac',
    siblings: [firstWork],
    expanded: true,
    onExpandedChange,
    onDrag,
    onDragEnd,
    onChooseTarget,
    onOrganize,
  }

  const { rerender } = render(<StandInWorkMessages {...props} work={firstWork} />)
  await waitFor(() => expect(screen.getByText(/Earlier source details/)).toBeInTheDocument())

  response = { messages: [message('Updated source details')] }
  const nextWork = work('version-2')
  rerender(<StandInWorkMessages {...props} work={nextWork} />)

  await waitFor(() => expect(screen.getByText(/Updated source details/)).toBeInTheDocument())
  expect(workMessages).toHaveBeenCalledTimes(2)

  workMessages.mockImplementationOnce(() => new Promise(() => {}))
  rerender(
    <StandInWorkMessages
      {...props}
      work={{ ...nextWork, source: { ...source, accountId: 'another-account' } }}
    />
  )

  expect(screen.queryByText(/Updated source details/)).not.toBeInTheDocument()
  expect(workMessages).toHaveBeenCalledTimes(3)
})
