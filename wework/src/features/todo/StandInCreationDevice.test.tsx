import '@/i18n'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { DeviceInfo } from '@/types/api'
import { navigateTo } from '@/lib/navigation'
import { StandInCreationDevice } from './StandInCreationDevice'

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const device = (id: string, overrides: Partial<DeviceInfo> = {}): DeviceInfo => ({
  id: id === 'one' ? 1 : 2,
  device_id: id,
  name: id,
  status: 'online',
  device_type: 'cloud',
  is_default: false,
  bind_shell: 'claudecode',
  ...overrides,
})
const editor = (deviceId: string) => <span data-testid="target">{deviceId}</span>

test('uses the only cloud device automatically and ignores local devices', () => {
  render(
    <StandInCreationDevice devices={[device('mac', { device_type: 'app' }), device('one')]}>
      {editor}
    </StandInCreationDevice>
  )
  expect(screen.getByTestId('target').textContent).toBe('one')
  expect(screen.queryByTestId('stand-in-device')).toBeNull()
})

test('requires an explicit selection when more than one device is available', () => {
  render(
    <StandInCreationDevice devices={[device('one'), device('two', { device_type: 'remote' })]}>
      {editor}
    </StandInCreationDevice>
  )
  expect(screen.queryByTestId('target')).toBeNull()
  fireEvent.change(screen.getByTestId('stand-in-device'), { target: { value: 'two' } })
  expect(screen.getByTestId('target').textContent).toBe('two')
})

test('keeps the selected device when availability changes, preserving the editor draft', () => {
  const view = render(
    <StandInCreationDevice devices={[device('one')]}>{editor}</StandInCreationDevice>
  )
  view.rerender(
    <StandInCreationDevice devices={[device('one', { status: 'offline' }), device('two')]}>
      {editor}
    </StandInCreationDevice>
  )
  expect(screen.getByTestId('target').textContent).toBe('one')
})

test('uses the device when inventory arrives after the creation page mounts', () => {
  const view = render(<StandInCreationDevice devices={[]}>{editor}</StandInCreationDevice>)
  expect(screen.queryByTestId('target')).toBeNull()
  view.rerender(<StandInCreationDevice devices={[device('one')]}>{editor}</StandInCreationDevice>)
  expect(screen.getByTestId('target').textContent).toBe('one')
})

test('offline cloud devices never cause a local fallback and lead to Cloud work', () => {
  const onCancel = vi.fn()
  render(
    <StandInCreationDevice
      onCancel={onCancel}
      devices={[device('one', { status: 'offline' }), device('mac', { device_type: 'app' })]}
    >
      {editor}
    </StandInCreationDevice>
  )
  expect(screen.queryByTestId('target')).toBeNull()
  fireEvent.click(screen.getByTestId('stand-in-open-cloud-work'))
  expect(onCancel).toHaveBeenCalledOnce()
  expect(navigateTo).toHaveBeenCalledWith('/cloud-work')
})
