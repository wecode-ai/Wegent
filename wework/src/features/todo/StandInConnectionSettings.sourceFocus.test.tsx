import { render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  STAND_IN_DINGTALK_PROVIDER,
  newStandInPrimaryRole,
  type StandInSourceConnection,
} from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor, StandInExecutorApi } from '@/api/standIn'
import type { MessageCenterSource } from '@/api/standInMessageCenter'
import { StandInConnectionSettings } from './StandInConnectionSettings'

const provider: ConnectionProviderDescriptor = {
  id: STAND_IN_DINGTALK_PROVIDER,
  displayName: 'DingTalk',
  resourceKinds: ['direct', 'group'],
  availability: { status: 'ready' },
  dependencies: [],
}

const source: StandInSourceConnection = {
  providerId: STAND_IN_DINGTALK_PROVIDER,
  id: 'conversation-one',
  profile: 'organization:owner',
  name: 'Owner chat',
  kind: 'direct',
  accountId: 'account',
  policy: { automatic: true, askBeforeAct: false, immediate: true },
}

const messageCenterSource: MessageCenterSource = {
  id: JSON.stringify(['direct', source.id]),
  conversationId: source.id,
  name: source.name,
  kind: 'direct',
  included: true,
  paused: false,
}

function renderSettings(
  initialSource?: MessageCenterSource,
  connections: StandInSourceConnection[] = [source]
) {
  const api = {
    connectionProviders: vi.fn(async () => ({ items: [provider] })),
  } as unknown as StandInExecutorApi
  const role = { ...newStandInPrimaryRole('device'), connections }
  render(
    <StandInConnectionSettings
      role={role}
      projects={[]}
      api={api}
      deviceId="device"
      localDeviceId="device"
      disabled={false}
      onChange={() => {}}
      initialSource={initialSource}
    />
  )
}

test('opens the requested DingTalk source and focuses its row', async () => {
  renderSettings(messageCenterSource)

  expect(await screen.findByTestId('stand-in-dingtalk-connections')).toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-connection-type-picker')).not.toBeInTheDocument()
  await waitFor(() =>
    expect(screen.getByTestId('stand-in-dingtalk-pause-conversation-one')).toHaveFocus()
  )
})

test('keeps the home settings entry at the provider catalog', async () => {
  renderSettings()

  expect(await screen.findByTestId('stand-in-connection-type-picker')).toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-dingtalk-connections')).not.toBeInTheDocument()
})

test('falls back to the provider row when the requested source is gone', async () => {
  renderSettings({ ...messageCenterSource, conversationId: 'removed-conversation' })

  expect(await screen.findByTestId('stand-in-connection-type-picker')).toBeInTheDocument()
  await waitFor(() => expect(screen.getByTestId('stand-in-add-dingtalk-connection')).toHaveFocus())
})
