import '@/i18n'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { DeviceInfo } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { StandInCreationDevice } from './StandInCreationDevice'

afterEach(cleanup)
const device = (id: string, overrides: Partial<DeviceInfo> = {}): DeviceInfo => ({
  id: 1,
  device_id: id,
  name: id,
  status: 'online',
  device_type: 'cloud',
  is_default: false,
  bind_shell: 'codex',
  ...overrides,
})
const services = {
  getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'mac' }),
} as WorkbenchServices
const editor = (deviceId: string, local: boolean) => (
  <span data-testid="target" data-local={String(local)}>
    {deviceId}
  </span>
)
const requestLeave = (action: () => void) => action()

test('defaults to an available cloud device while allowing an explicit local choice', async () => {
  render(
    <StandInCreationDevice
      services={services}
      requestLeave={requestLeave}
      devices={[device('one')]}
    >
      {editor}
    </StandInCreationDevice>
  )
  expect(await screen.findByTestId('target')).toHaveTextContent('one')
  fireEvent.change(screen.getByTestId('stand-in-device'), { target: { value: 'mac' } })
  expect(screen.getByTestId('target')).toHaveTextContent('mac')
  expect(screen.getByTestId('target')).toHaveAttribute('data-local', 'true')
})

test('prefers the designated default and allows another cloud device', async () => {
  render(
    <StandInCreationDevice
      services={services}
      requestLeave={requestLeave}
      devices={[device('one'), device('two', { device_type: 'remote', is_default: true })]}
    >
      {editor}
    </StandInCreationDevice>
  )
  expect(await screen.findByTestId('target')).toHaveTextContent('two')
  fireEvent.change(screen.getByTestId('stand-in-device'), { target: { value: 'one' } })
  expect(screen.getByTestId('target')).toHaveTextContent('one')
})

test('uses the local device when no cloud device is available', async () => {
  render(
    <StandInCreationDevice
      services={services}
      requestLeave={requestLeave}
      devices={[device('one', { status: 'offline' })]}
    >
      {editor}
    </StandInCreationDevice>
  )
  expect(await screen.findByTestId('target')).toHaveTextContent('mac')
})

test('keeps the selected device when inventory changes instead of discarding the editor', async () => {
  const view = render(
    <StandInCreationDevice
      services={services}
      requestLeave={requestLeave}
      devices={[device('one')]}
    >
      {editor}
    </StandInCreationDevice>
  )
  const target = await screen.findByTestId('target')
  view.rerender(
    <StandInCreationDevice
      services={services}
      requestLeave={requestLeave}
      devices={[device('one', { status: 'offline' }), device('two')]}
    >
      {editor}
    </StandInCreationDevice>
  )
  await waitFor(() => expect(screen.getByTestId('target')).toBe(target))
  expect(target).toHaveTextContent('one')
})

test('guards a device change with the existing unsaved-edit decision', async () => {
  const guard = vi.fn()
  render(
    <StandInCreationDevice services={services} requestLeave={guard} devices={[device('one')]}>
      {editor}
    </StandInCreationDevice>
  )
  await screen.findByTestId('target')
  fireEvent.change(screen.getByTestId('stand-in-device'), { target: { value: 'mac' } })
  expect(guard).toHaveBeenCalledOnce()
  expect(screen.getByTestId('target')).toHaveTextContent('one')
})

test('retries a failed local identity lookup without opening the wrong profile', async () => {
  const identity = vi
    .fn()
    .mockRejectedValueOnce(new Error('unavailable'))
    .mockResolvedValue({ deviceId: 'mac' })
  render(
    <StandInCreationDevice
      services={{ getLocalRuntimeSidebarIdentity: identity } as WorkbenchServices}
      requestLeave={requestLeave}
      devices={[]}
    >
      {editor}
    </StandInCreationDevice>
  )
  fireEvent.click(await screen.findByTestId('stand-in-device-retry'))
  expect(await screen.findByTestId('target')).toHaveTextContent('mac')
})
