import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { newStandInRole } from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor, StandInExecutorApi } from '@/api/standIn'
import '@/i18n'
import { StandInConnectionSettings } from './StandInConnectionSettings'

const provider = (id: string, displayName: string): ConnectionProviderDescriptor => ({
  id,
  displayName,
  resourceKinds: ['folder'],
  resourceLabels: { folder: '文件夹' },
  dependencies: [],
  availability: { status: 'ready' },
})
const props = {
  role: newStandInRole('mac'),
  projects: [],
  deviceId: 'mac',
  localDeviceId: 'mac',
  disabled: false,
  onChange: vi.fn(),
}

it('discovers independent connection plugins and routes resource searches to the selected provider', async () => {
  const searchConnectionResources = vi.fn(async () => ({ items: [] }))
  const api = {
    connectionProviders: vi.fn(async () => ({
      items: [provider('@test/mail/inbox', '邮箱'), provider('@test/calendar/events', '日历')],
    })),
    searchConnectionResources,
  } as unknown as StandInExecutorApi
  const user = userEvent.setup()
  render(<StandInConnectionSettings {...props} api={api} />)
  await user.click(screen.getByTestId('stand-in-add-connection'))
  await user.click(await screen.findByTestId('stand-in-add-@test/mail/inbox-connection'))
  await user.click(screen.getByTestId('stand-in-connection-@test/mail/inbox-add'))
  await user.type(screen.getByTestId('stand-in-connection-@test/mail/inbox-query'), 'Inbox')
  await user.click(screen.getByTestId('stand-in-connection-@test/mail/inbox-search'))
  expect(searchConnectionResources).toHaveBeenCalledWith(
    'mac',
    '@test/mail/inbox',
    'folder',
    'Inbox',
    undefined
  )
})

it('installs dependencies only after the user clicks the installation action', async () => {
  const item = {
    ...provider('@test/mail/inbox', '邮箱'),
    availability: { status: 'dependency_missing' },
    dependencies: [{ alias: 'mail', status: 'missing' }],
  }
  const installConnectionDependencies = vi.fn(async () => {})
  const api = {
    connectionProviders: vi.fn(async () => ({ items: [item] })),
    installConnectionDependencies,
  } as unknown as StandInExecutorApi
  const user = userEvent.setup()
  render(<StandInConnectionSettings {...props} api={api} />)
  await user.click(screen.getByTestId('stand-in-add-connection'))
  const install = await screen.findByTestId('stand-in-install-dependencies-@test/mail/inbox')
  expect(installConnectionDependencies).not.toHaveBeenCalled()
  await user.click(install)
  expect(installConnectionDependencies).toHaveBeenCalledWith('mac', '@test/mail/inbox', ['mail'])
})

it('does not apply a previous device catalog after changing the selected device', async () => {
  let finish!: (value: { items: ConnectionProviderDescriptor[] }) => void
  const api = {
    connectionProviders: vi
      .fn()
      .mockReturnValueOnce(
        new Promise(resolve => {
          finish = resolve
        })
      )
      .mockResolvedValue({ items: [provider('@test/new/inbox', '新设备邮箱')] }),
  } as unknown as StandInExecutorApi
  const user = userEvent.setup()
  const view = render(<StandInConnectionSettings {...props} api={api} />)
  view.rerender(<StandInConnectionSettings {...props} api={api} deviceId="other" />)
  await user.click(screen.getByTestId('stand-in-add-connection'))
  await screen.findByText('新设备邮箱')
  await act(async () => finish({ items: [provider('@test/old/inbox', '旧设备邮箱')] }))
  expect(screen.queryByText('旧设备邮箱')).not.toBeInTheDocument()
})
