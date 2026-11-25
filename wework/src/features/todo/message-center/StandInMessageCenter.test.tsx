import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { MessageCenterSnapshot, MessageCenterSource } from '@/api/standInMessageCenter'
import '@/i18n'
import { StandInMessageCenter } from './StandInMessageCenter'

it('uses the shared settings entry and identifies the exact source from details', async () => {
  const user = userEvent.setup()
  const source: MessageCenterSource = {
    id: 'group:conversation',
    conversationId: 'conversation',
    name: '项目讨论群',
    kind: 'group',
    paused: true,
    included: true,
  }
  const snapshot: MessageCenterSnapshot = {
    identity: { id: 'dingtalk-account', account: '测试账号', organization: '测试组织' },
    deviceName: 'This Mac',
    updatedAt: null,
    status: 'paused',
    records: [
      {
        id: 'record',
        title: '项目链接',
        sourceId: source.id,
        sourceName: source.name,
        sender: '测试联系人',
        message: '项目链接在哪？',
        at: '2026-11-20T09:00:00Z',
        decision: 'needs_user',
        progress: 'complete',
        delivery: 'none',
        takenOver: false,
        deviceName: 'This Mac',
      },
    ],
    sources: [{ ...source, id: 'direct:conversation', name: '测试私聊', kind: 'direct' }, source],
    policyVersion: 5,
    capabilities: [],
  }
  const onOpenSettings = vi.fn()
  render(
    <StandInMessageCenter
      snapshot={snapshot}
      loading={false}
      error={false}
      busy={false}
      actionError={false}
      onCommand={vi.fn(async () => true)}
      onOpenSettings={onOpenSettings}
      onRefresh={vi.fn()}
    />
  )

  await user.click(screen.getByTestId('message-center-open-settings'))
  expect(onOpenSettings).toHaveBeenNthCalledWith(1)

  await user.click(screen.getByRole('button', { name: /项目链接/ }))
  await user.click(screen.getByTestId('message-center-detail-settings'))
  expect(onOpenSettings).toHaveBeenNthCalledWith(2, source)
  expect(screen.getByTestId('message-center-detail')).toBeInTheDocument()
})
