import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import '@/i18n'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { StandInImConnections } from './StandInImConnections'

function fixture() {
  const session = { session_key: 'session', channel_label: 'Telegram', display_name: 'Alice' }
  const bindStandIn = vi.fn().mockImplementation(async (_key, binding) => binding)
  const listPrivateSessions = vi.fn().mockResolvedValue({ items: [session] })
  const services = {
    imSessionApi: { listPrivateSessions, bindStandIn },
  } as unknown as WorkbenchServices
  return { services, bindStandIn, listPrivateSessions }
}

it('connects IM to the selected role and device immediately', async () => {
  const f = fixture()
  render(<StandInImConnections services={f.services} deviceId="mac" roleId="reviewer" />)
  fireEvent.click(await screen.findByTestId('stand-in-im-connect-session'))
  await waitFor(() =>
    expect(f.bindStandIn).toHaveBeenCalledWith('session', { deviceId: 'mac', roleId: 'reviewer' })
  )
  await waitFor(() => expect(screen.getByTestId('stand-in-im-connect-session')).toBeDisabled())
})

it('connects the primary identity without a task address or model override', async () => {
  const f = fixture()
  render(<StandInImConnections services={f.services} deviceId="mac" />)
  fireEvent.click(await screen.findByTestId('stand-in-im-connect-session'))
  await waitFor(() =>
    expect(f.bindStandIn).toHaveBeenCalledWith('session', { deviceId: 'mac', roleId: null })
  )
})

it('keeps the session available for manual retry after a failed connection', async () => {
  const f = fixture()
  f.bindStandIn.mockRejectedValueOnce(new Error('offline'))
  render(<StandInImConnections services={f.services} deviceId="mac" />)
  fireEvent.click(await screen.findByTestId('stand-in-im-connect-session'))
  await screen.findByRole('alert')
  expect(screen.getByTestId('stand-in-im-connect-session')).toBeEnabled()
  fireEvent.click(screen.getByTestId('stand-in-im-connect-session'))
  await waitFor(() => expect(screen.getByTestId('stand-in-im-connect-session')).toBeDisabled())
  expect(f.bindStandIn).toHaveBeenCalledTimes(2)
})

it('ignores a late list response after changing identities', async () => {
  const f = fixture()
  let finish!: (value: unknown) => void
  f.listPrivateSessions.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const view = render(<StandInImConnections services={f.services} deviceId="old" />)
  view.rerender(<StandInImConnections services={f.services} deviceId="new" roleId="reviewer" />)
  await screen.findByTestId('stand-in-im-connect-session')
  finish({ items: [{ session_key: 'stale', display_name: 'Old' }] })
  await waitFor(() =>
    expect(screen.queryByTestId('stand-in-im-connect-stale')).not.toBeInTheDocument()
  )
  fireEvent.click(screen.getByTestId('stand-in-im-connect-session'))
  await waitFor(() =>
    expect(f.bindStandIn).toHaveBeenCalledWith('session', { deviceId: 'new', roleId: 'reviewer' })
  )
})

it('offers refresh when listing fails and does not show a task picker', async () => {
  const f = fixture()
  f.listPrivateSessions.mockRejectedValueOnce(new Error('network'))
  render(<StandInImConnections services={f.services} deviceId="mac" />)
  await screen.findByRole('alert')
  fireEvent.click(screen.getByTestId('stand-in-im-refresh'))
  await screen.findByTestId('stand-in-im-connect-session')
  expect(screen.queryByTestId('continue-in-im-button')).not.toBeInTheDocument()
})

it('retains loaded conversations on refresh failure without claiming the list is empty', async () => {
  const f = fixture()
  render(<StandInImConnections services={f.services} deviceId="mac" />)
  await screen.findByTestId('stand-in-im-connect-session')
  f.listPrivateSessions.mockRejectedValueOnce(new Error('network'))
  fireEvent.click(screen.getByTestId('stand-in-im-refresh'))
  await screen.findByRole('alert')
  expect(screen.getByTestId('stand-in-im-connect-session')).toBeInTheDocument()
  expect(screen.queryByText(/暂无 IM 私聊/)).not.toBeInTheDocument()
})

it('does not retain a pending save when switching identities', async () => {
  const f = fixture()
  let finish!: (binding: unknown) => void
  f.bindStandIn.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const view = render(<StandInImConnections services={f.services} deviceId="mac" />)
  fireEvent.click(await screen.findByTestId('stand-in-im-connect-session'))
  view.rerender(<StandInImConnections services={f.services} deviceId="other" roleId="reviewer" />)
  await waitFor(() => expect(screen.getByTestId('stand-in-im-connect-session')).toBeEnabled())
  finish({ deviceId: 'mac', roleId: null })
  fireEvent.click(screen.getByTestId('stand-in-im-connect-session'))
  await waitFor(() =>
    expect(f.bindStandIn).toHaveBeenLastCalledWith('session', {
      deviceId: 'other',
      roleId: 'reviewer',
    })
  )
})

it('recognizes a saved record route as the same selected local executor', async () => {
  const f = fixture()
  f.bindStandIn.mockResolvedValue({ deviceId: 'app-record-42', roleId: null })
  const devices = [
    {
      id: 42,
      device_id: 'electron-mac',
      app_device_id: 'electron-mac',
      name: 'Local',
      status: 'online',
      is_default: true,
      runtime_routes: [
        { kind: 'cloud-relay', device_id: 'app-record-42', runtime_device_id: 'app-record-42' },
      ],
    },
  ] as import('@/types/api').DeviceInfo[]
  render(<StandInImConnections services={f.services} deviceId="electron-mac" devices={devices} />)
  fireEvent.click(await screen.findByTestId('stand-in-im-connect-session'))
  await waitFor(() => expect(screen.getByTestId('stand-in-im-connect-session')).toBeDisabled())
})

it('labels the chat-mode action as connecting to the stand-in', async () => {
  const f = fixture()
  f.listPrivateSessions.mockResolvedValue({
    items: [
      {
        session_key: 'session',
        display_name: 'Alice',
        mode: 'chat',
        stand_in: { deviceId: 'mac', roleId: null },
      },
    ],
  })
  render(<StandInImConnections services={f.services} deviceId="mac" />)
  const button = await screen.findByTestId('stand-in-im-connect-session')
  expect(button).toHaveTextContent('连接到此分身')
  expect(button).toBeEnabled()
  fireEvent.click(button)
  await waitFor(() => expect(button).toHaveTextContent('已连接当前分身'))
})
