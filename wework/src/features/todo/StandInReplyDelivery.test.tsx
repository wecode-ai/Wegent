import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { StandInExecutorApi, StandInInboxWork, StandInReplyDelivery } from '@/api/standIn'
import { selectExperienceWorkSnapshot } from '@/features/collaboration-exp/model/workSnapshotSelectors'
import '@/i18n'
import { inboxRuntimeItem } from './useStandInInbox'
import { StandInWorkList } from './StandInWorkList'

function work(id = 'work'): StandInInboxWork {
  return {
    id,
    taskId: id,
    roleId: 'review',
    title: '评审方案',
    status: 'pending',
    updatedAt: '2026-10-24T00:00:00Z',
    source: {
      providerId: '@wegent/dsh-connection-dingtalk/dingtalk',
      id: 'group',
      profile: 'corp:user',
      name: '项目讨论群',
      kind: 'group',
      policy: { automatic: false, askBeforeAct: true },
    },
    messageCount: 1,
    latestMessage: {
      id: 'message',
      recordId: 'record',
      senderId: 'alice',
      text: '请检查这份方案',
      at: '2026-10-24T00:00:00Z',
      source: {
        providerId: '@wegent/dsh-connection-dingtalk/dingtalk',
        id: 'group',
        profile: 'corp:user',
        name: '项目讨论群',
        kind: 'group',
        policy: { automatic: false, askBeforeAct: true },
      },
    },
  }
}

it('preserves unknown delivery after takeover and only displays sent replies with a receipt', async () => {
  const user = userEvent.setup()
  const takeOverWork = vi.fn(async () => ({ success: true as const }))
  const verifyDelivery = vi.fn(async () => ({ replyDelivery: { status: 'unknown' } }))
  const runWork = vi.fn()
  const onRefresh = vi.fn()
  const api = {
    takeOverWork,
    verifyDelivery,
    runWork,
    workMessages: vi.fn(async () => ({ messages: [] })),
  }
  const show = (replyDelivery: StandInReplyDelivery) => {
    const item = { ...work(), status: 'sent' as const, replyDelivery }
    return (
      <StandInWorkList
        items={[inboxRuntimeItem(item, 'device')]}
        inbox={[item]}
        api={api as unknown as StandInExecutorApi}
        userId={0}
        deviceId="device"
        onRefresh={onRefresh}
      />
    )
  }
  const view = render(show({ status: 'processing' }))
  const row = screen.getByTestId('stand-in-activity-task-work')
  expect(row).toHaveTextContent('正在处理')
  await user.click(row)
  expect(screen.getByTestId('stand-in-preview-close')).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(row).toHaveFocus()
  await user.keyboard('{Enter}')
  await user.click(screen.getByTestId('stand-in-reply-takeover'))
  expect(takeOverWork).toHaveBeenCalledWith(0, 'device', 'work')
  expect(onRefresh).toHaveBeenCalled()
  view.rerender(show({ status: 'unknown', takenOver: true }))
  expect(row).toHaveTextContent('结果未知 · 本人已接管')
  const preview = within(screen.getByTestId('stand-in-work-preview'))
  expect(preview.getByText('结果未知')).toBeVisible()
  expect(preview.getByText('本人已接管')).toBeVisible()
  expect(preview.queryByTestId('stand-in-reply-takeover')).not.toBeInTheDocument()
  expect(preview.queryByTestId('stand-in-reply-delivery-verify')).not.toBeInTheDocument()
  view.rerender(
    show({ status: 'unknown', takenOver: true, recordId: 'record', channelTaskId: 'task' })
  )
  await user.click(preview.getByTestId('stand-in-reply-delivery-verify'))
  expect(verifyDelivery).toHaveBeenCalledWith(0, 'device', 'work', 'record')
  expect(runWork).not.toHaveBeenCalled()
  view.rerender(show({ status: 'confirmed_sent' }))
  expect(row).toHaveTextContent('结果未知')
  await user.click(screen.getByTestId('stand-in-filter-replied'))
  expect(screen.queryByTestId('stand-in-activity-task-work')).not.toBeInTheDocument()
  view.rerender(show({ status: 'confirmed_sent', receipt: { messageId: 'channel-message' } }))
  expect(screen.getByTestId('stand-in-activity-task-work')).toHaveTextContent('已回复')
  expect(preview.getByTestId('stand-in-reply-delivery-receipt')).toHaveTextContent(
    'channel-message'
  )
})

it('excludes unknown and unconfirmed work from completed assistant counts', () => {
  const item = { ...work(), status: 'sent' as const }
  const forDelivery = (replyDelivery: StandInReplyDelivery) =>
    selectExperienceWorkSnapshot({
      roles: [],
      work: [inboxRuntimeItem({ ...item, replyDelivery }, 'device')],
    })
  expect(forDelivery({ status: 'unknown' }).counts.completed).toBe(0)
  expect(forDelivery({ status: 'confirmed_sent' }).counts.completed).toBe(0)
  expect(
    forDelivery({ status: 'confirmed_sent', receipt: { messageId: 'receipt' } }).counts.completed
  ).toBe(1)
  expect(forDelivery({ status: 'processing' }).current?.address).toBeUndefined()
})
