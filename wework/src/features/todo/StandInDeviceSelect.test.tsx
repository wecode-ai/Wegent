import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { DeviceInfo } from '@/types/api'
import '@/i18n'
import { StandInDeviceSelect } from './StandInDeviceSelect'

it('lets each role select an online device independently', async () => {
  const onChange = vi.fn()
  render(
    <StandInDeviceSelect
      value="cloud"
      currentDeviceId="mac"
      devices={[
        { device_id: 'cloud', name: 'Cloud one', status: 'online' } as DeviceInfo,
        { device_id: 'offline', name: 'Offline', status: 'offline' } as DeviceInfo,
      ]}
      disabled={false}
      onChange={onChange}
    />
  )
  expect(screen.getByText('Cloud one')).toBeVisible()
  expect(screen.getByRole('combobox')).toHaveValue('cloud')
  expect(screen.getByRole('option', { name: 'Offline' })).toBeDisabled()
  await userEvent.selectOptions(screen.getByRole('combobox'), 'mac')
  expect(onChange).toHaveBeenCalledWith('mac')
})
