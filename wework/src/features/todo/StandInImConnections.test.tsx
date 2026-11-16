import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import '@/i18n'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { StandInImConnections } from './StandInImConnections'

async function openTelegram() {
  if (!screen.queryByTestId('stand-in-im-dialog'))
    fireEvent.click(screen.getByTestId('stand-in-im-channel-telegram'))
}

function fixture() {
  const session = {
    session_key: 'session',
    channel_type: 'telegram',
    channel_label: 'Telegram',
    display_name: 'Alice',
  }
  const bindStandIn = vi.fn().mockImplementation(async (_key, binding) => binding)
  const listPrivateSessions = vi.fn().mockResolvedValue({ items: [session] })
  const services = {
    imSessionApi: { listPrivateSessions, bindStandIn },
  } as unknown as WorkbenchServices
  return { services, bindStandIn, listPrivateSessions }
}

it('connects IM to the selected role and device immediately', async () => {
  const f = fixture()
  render(
    <StandInImConnections name="评审分身" services={f.services} deviceId="mac" roleId="reviewer" />
  )
  await openTelegram()
  fireEvent.click(await screen.findByTestId('stand-in-im-submit'))
  await waitFor(() =>
    expect(f.bindStandIn).toHaveBeenCalledWith('session', { deviceId: 'mac', roleId: 'reviewer' })
  )
  await waitFor(() => expect(screen.getByTestId('stand-in-im-submit')).toHaveTextContent('完成'))
})

it('connects the primary identity without a task address or model override', async () => {
  const f = fixture()
  render(<StandInImConnections name="评审分身" services={f.services} deviceId="mac" />)
  await openTelegram()
  fireEvent.click(await screen.findByTestId('stand-in-im-submit'))
  await waitFor(() =>
    expect(f.bindStandIn).toHaveBeenCalledWith('session', { deviceId: 'mac', roleId: null })
  )
})

it('keeps the session available for manual retry after a failed connection', async () => {
  const f = fixture()
  f.bindStandIn.mockRejectedValueOnce(new Error('offline'))
  render(<StandInImConnections name="评审分身" services={f.services} deviceId="mac" />)
  await openTelegram()
  fireEvent.click(await screen.findByTestId('stand-in-im-submit'))
  await screen.findByRole('alert')
  expect(screen.getByTestId('stand-in-im-submit')).toBeEnabled()
  fireEvent.click(screen.getByTestId('stand-in-im-submit'))
  await waitFor(() => expect(screen.getByTestId('stand-in-im-submit')).toHaveTextContent('完成'))
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
  const view = render(<StandInImConnections name="评审分身" services={f.services} deviceId="old" />)
  view.rerender(
    <StandInImConnections name="评审分身" services={f.services} deviceId="new" roleId="reviewer" />
  )
  await openTelegram()
  await screen.findByTestId('stand-in-im-connect-session')
  finish({ items: [{ session_key: 'stale', display_name: 'Old' }] })
  await waitFor(() =>
    expect(screen.queryByTestId('stand-in-im-connect-stale')).not.toBeInTheDocument()
  )
  fireEvent.click(screen.getByTestId('stand-in-im-submit'))
  await waitFor(() =>
    expect(f.bindStandIn).toHaveBeenCalledWith('session', { deviceId: 'new', roleId: 'reviewer' })
  )
})

it('offers refresh when listing fails and does not show a task picker', async () => {
  const f = fixture()
  f.listPrivateSessions.mockRejectedValueOnce(new Error('network'))
  render(<StandInImConnections name="评审分身" services={f.services} deviceId="mac" />)
  await openTelegram()
  await screen.findByRole('alert')
  fireEvent.click(screen.getByTestId('stand-in-im-refresh'))
  await openTelegram()
  await screen.findByTestId('stand-in-im-connect-session')
  expect(screen.queryByTestId('continue-in-im-button')).not.toBeInTheDocument()
})

it('retains loaded conversations on refresh failure without claiming the list is empty', async () => {
  const f = fixture()
  render(<StandInImConnections name="评审分身" services={f.services} deviceId="mac" />)
  await openTelegram()
  await screen.findByTestId('stand-in-im-connect-session')
  f.listPrivateSessions.mockRejectedValueOnce(new Error('network'))
  fireEvent.click(screen.getByTestId('stand-in-im-refresh'))
  await screen.findByRole('alert')
  expect(screen.getByTestId('stand-in-im-connect-session')).toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-im-empty')).not.toBeInTheDocument()
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
  const view = render(<StandInImConnections name="评审分身" services={f.services} deviceId="mac" />)
  await openTelegram()
  fireEvent.click(await screen.findByTestId('stand-in-im-submit'))
  view.rerender(
    <StandInImConnections
      name="评审分身"
      services={f.services}
      deviceId="other"
      roleId="reviewer"
    />
  )
  expect(screen.queryByTestId('stand-in-im-dialog')).not.toBeInTheDocument()
  await openTelegram()
  await waitFor(() => expect(screen.getByTestId('stand-in-im-submit')).toBeEnabled())
  finish({ deviceId: 'mac', roleId: null })
  fireEvent.click(screen.getByTestId('stand-in-im-submit'))
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
  render(
    <StandInImConnections
      name="评审分身"
      services={f.services}
      deviceId="electron-mac"
      devices={devices}
    />
  )
  await openTelegram()
  fireEvent.click(await screen.findByTestId('stand-in-im-submit'))
  await waitFor(() => expect(screen.getByTestId('stand-in-im-submit')).toHaveTextContent('完成'))
})

it('labels the chat-mode action as connecting to the stand-in', async () => {
  const f = fixture()
  f.listPrivateSessions.mockResolvedValue({
    items: [
      {
        session_key: 'session',
        display_name: 'Alice',
        channel_type: 'telegram',
        mode: 'chat',
        stand_in: { deviceId: 'mac', roleId: null },
      },
    ],
  })
  render(<StandInImConnections name="评审分身" services={f.services} deviceId="mac" />)
  await openTelegram()
  const button = await screen.findByTestId('stand-in-im-submit')
  expect(button).toHaveTextContent('连接「评审分身」')
  expect(button).toBeEnabled()
  fireEvent.click(button)
  await waitFor(() => expect(button).toHaveTextContent('完成'))
})

it('opens from channel controls without exposing sessions or mode instructions in the popover', async () => {
  const f = fixture()
  render(<StandInImConnections name="评审分身" services={f.services} deviceId="mac" />)
  expect(screen.getByTestId('stand-in-im-channel-telegram')).toBeVisible()
  expect(screen.queryByTestId('stand-in-im-connect-session')).not.toBeInTheDocument()
  expect(screen.queryByText(/发送 \/chat/)).not.toBeInTheDocument()
  await openTelegram()
  expect(await screen.findByRole('dialog', { name: '设置 Telegram' })).toBeVisible()
  expect(screen.getByText('在 Telegram 私聊中与「评审分身」对话。')).toBeVisible()
  expect(f.bindStandIn).not.toHaveBeenCalled()
})

it('filters sessions by channel and requires a choice when multiple private chats exist', async () => {
  const f = fixture()
  f.listPrivateSessions.mockResolvedValue({
    items: [
      { session_key: 'one', channel_type: 'telegram', display_name: 'Alice' },
      { session_key: 'two', channel_type: 'telegram', display_name: 'Bob' },
      { session_key: 'other', channel_type: 'dingtalk', display_name: 'DingTalk user' },
    ],
  })
  render(<StandInImConnections name="评审分身" services={f.services} deviceId="mac" />)
  await openTelegram()
  await screen.findByTestId('stand-in-im-connect-one')
  expect(screen.queryByText('DingTalk user')).not.toBeInTheDocument()
  expect(screen.getByTestId('stand-in-im-submit')).toBeDisabled()
  fireEvent.click(screen.getByTestId('stand-in-im-connect-two'))
  expect(f.bindStandIn).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('stand-in-im-submit'))
  await waitFor(() =>
    expect(f.bindStandIn).toHaveBeenCalledWith('two', { deviceId: 'mac', roleId: null })
  )
})

it('explains registration only for the selected empty channel', async () => {
  const f = fixture()
  f.listPrivateSessions.mockResolvedValue({ items: [] })
  render(<StandInImConnections name="评审分身" services={f.services} deviceId="mac" />)
  await openTelegram()
  expect(await screen.findByTestId('stand-in-im-empty')).toHaveTextContent('发送 /bind')
  expect(screen.getByTestId('stand-in-im-refresh')).toBeEnabled()
  expect(screen.queryByTestId('stand-in-im-submit')).not.toBeInTheDocument()
})

it('restores keyboard focus to the exact channel trigger on Escape', async () => {
  const f = fixture()
  const user = (await import('@testing-library/user-event')).default.setup()
  const onOpenChange = vi.fn()
  render(
    <StandInImConnections
      name="评审分身"
      services={f.services}
      deviceId="mac"
      onOpenChange={onOpenChange}
    />
  )
  const trigger = screen.getByTestId('stand-in-im-channel-telegram')
  await user.click(trigger)
  await screen.findByTestId('stand-in-im-connect-session')
  expect(onOpenChange).toHaveBeenLastCalledWith(true)
  await user.keyboard('{Escape}')
  expect(screen.queryByTestId('stand-in-im-dialog')).not.toBeInTheDocument()
  await waitFor(() => expect(trigger).toHaveFocus())
  expect(onOpenChange).toHaveBeenLastCalledWith(false)
})

it('keeps channel entry visible without cloud sign-in and explains the next action in its dialog', async () => {
  render(<StandInImConnections name="评审分身" services={{} as WorkbenchServices} deviceId="mac" />)
  await openTelegram()
  expect(screen.getByText(/点击左侧“连接云端”登录/)).toBeVisible()
  expect(screen.queryByTestId('stand-in-im-submit')).not.toBeInTheDocument()
})

it('does not carry a Telegram save failure into another channel', async () => {
  const f = fixture()
  f.bindStandIn.mockRejectedValueOnce(new Error('offline'))
  render(<StandInImConnections name="评审分身" services={f.services} deviceId="mac" />)
  await openTelegram()
  fireEvent.click(await screen.findByTestId('stand-in-im-submit'))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByTestId('stand-in-im-dialog-close'))
  fireEvent.click(screen.getByTestId('stand-in-im-channel-dingtalk'))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByTestId('stand-in-im-empty')).toHaveTextContent('钉钉')
  expect(screen.getByTestId('stand-in-im-refresh')).toBeEnabled()
})

it('keeps keyboard focus inside the dialog after its last disclosure control', async () => {
  const f = fixture()
  const user = (await import('@testing-library/user-event')).default.setup()
  render(<StandInImConnections name="评审分身" services={f.services} deviceId="mac" />)
  await openTelegram()
  await screen.findByTestId('stand-in-im-submit')
  await user.click(screen.getByTestId('stand-in-im-mode-help'))
  expect(screen.getByText(/发送 \/chat 可回到 Wegent 聊天/)).toBeVisible()
  await user.tab()
  expect(screen.getByTestId('stand-in-im-dialog-close')).toHaveFocus()
  await user.tab({ shift: true })
  expect(screen.getByTestId('stand-in-im-mode-help')).toHaveFocus()
})
