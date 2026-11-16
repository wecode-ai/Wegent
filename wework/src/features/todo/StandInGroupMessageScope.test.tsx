import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { newStandInRole } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import '@/i18n'
import { StandInSourceConnections } from './StandInSourceConnections'

const provider = {
  id: '@wegent/dsh-connection-dingtalk/dingtalk',
  displayName: 'DingTalk',
  resourceKinds: ['group', 'direct'],
  dependencies: [],
  availability: { status: 'ready' },
}
const group = {
  providerId: provider.id,
  id: 'feedback',
  name: 'Feedback',
  profile: 'account',
  kind: 'group',
  policy: { automatic: true, askBeforeAct: true, immediate: false },
}

it('edits one exact group in the draft, restores its saved mode and can return to mentions', async () => {
  const role = { ...newStandInRole('device'), connections: [group, { ...group, id: 'other' }] }
  const onChange = vi.fn()
  const props = {
    provider,
    role,
    onChange,
    api: {} as StandInExecutorApi,
    deviceId: 'device',
    localDeviceId: 'device',
    disabled: false,
  }
  const view = render(<StandInSourceConnections {...props} />)
  const user = userEvent.setup()
  const selector = 'stand-in-dingtalk-message-scope-feedback'
  expect(screen.getByTestId(selector)).toHaveValue('mentions')
  await user.selectOptions(screen.getByTestId(selector), 'all-messages')
  const changed = onChange.mock.calls[0][0]
  expect(changed.connections[0]).toMatchObject({ ...group, collectionKey: 'all-messages' })
  expect(changed.connections[1]).toEqual(role.connections[1])
  expect(role.connections[0]).not.toHaveProperty('collectionKey')
  view.rerender(<StandInSourceConnections {...props} role={changed} />)
  expect(screen.getByTestId(selector)).toHaveValue('all-messages')
  await user.selectOptions(screen.getByTestId(selector), 'mentions')
  expect(onChange.mock.calls[1][0].connections[0]).not.toHaveProperty('collectionKey')
  expect(onChange.mock.calls[1][0].connections[0].policy).toEqual(group.policy)
  view.rerender(<StandInSourceConnections {...props} role={changed} disabled />)
  expect(screen.getByTestId(selector)).toBeDisabled()
})

it('offers no all-message switch on all-group, direct or other-provider subscriptions', () => {
  const role = {
    ...newStandInRole('device'),
    connections: [
      { ...group, id: '*', scope: 'all' as const },
      { ...group, id: 'contact', kind: 'direct' },
      { ...group, id: 'foreign', providerId: 'example' },
    ],
  }
  render(
    <StandInSourceConnections
      role={role}
      provider={provider}
      api={{} as StandInExecutorApi}
      deviceId="device"
      localDeviceId="device"
      disabled={false}
      onChange={vi.fn()}
    />
  )
  expect(screen.queryByTestId('stand-in-dingtalk-message-scope-*')).not.toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-dingtalk-message-scope-contact')).not.toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-dingtalk-message-scope-foreign')).not.toBeInTheDocument()
})
