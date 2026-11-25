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

  const headerSettings = screen.getByTestId('message-center-open-settings')
  await user.click(headerSettings)
  expect(onOpenSettings).toHaveBeenNthCalledWith(1, undefined, headerSettings)

  await user.click(screen.getByRole('button', { name: /项目链接/ }))
  const detailSettings = screen.getByTestId('message-center-detail-settings')
  await user.click(detailSettings)
  expect(onOpenSettings).toHaveBeenNthCalledWith(2, source, detailSettings)
  expect(screen.getByTestId('message-center-detail')).toBeInTheDocument()
})

it('uses the host pause and resume capabilities in the header and disables them while saving', async () => {
  const user = userEvent.setup()
  const snapshot: MessageCenterSnapshot = {
    identity: { id: 'account', account: '测试账号', organization: '测试组织' },
    deviceName: 'This Mac',
    updatedAt: null,
    status: 'active',
    records: [],
    sources: [],
    policyVersion: 5,
    capabilities: ['pause'],
  }
  const onCommand = vi.fn(async () => true)
  const props = {
    loading: false,
    error: false,
    actionError: false,
    onCommand,
    onOpenSettings: vi.fn(),
    onRefresh: vi.fn(),
  }
  const { rerender } = render(<StandInMessageCenter {...props} snapshot={snapshot} busy={false} />)

  const control = screen.getByTestId('message-center-toggle-pause')
  expect(control).toHaveTextContent('暂停代管')
  await user.click(control)
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({ type: 'pause' })

  rerender(<StandInMessageCenter {...props} snapshot={snapshot} busy />)
  expect(control).toBeDisabled()
  await user.click(control)
  expect(onCommand).toHaveBeenCalledTimes(1)

  const paused = { ...snapshot, status: 'paused', capabilities: ['resume'] } as const
  rerender(<StandInMessageCenter {...props} snapshot={paused} busy={false} />)
  expect(control).toHaveTextContent('恢复代管')
  await user.click(control)
  expect(onCommand).toHaveBeenLastCalledWith({ type: 'resume' })

  rerender(
    <StandInMessageCenter {...props} snapshot={{ ...paused, capabilities: [] }} busy={false} />
  )
  expect(control).not.toBeInTheDocument()
})
