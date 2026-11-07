import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { DeviceInfo } from '@/types/api'
import '@/i18n'
import { StandInBindingContext } from './StandInBindingContext'
import { StandInDeviceSelect } from './StandInDeviceSelect'

it('shows the bound device as read-only context without any switch control', () => {
  const onChange = vi.fn()
  render(
    <StandInBindingContext.Provider value={{ userId: 7, deviceId: 'cloud' }}>
      <StandInDeviceSelect
        value="cloud"
        currentDeviceId="mac"
        devices={[{ device_id: 'cloud', name: 'Cloud one' } as DeviceInfo]}
        disabled={false}
        onChange={onChange}
      />
    </StandInBindingContext.Provider>
  )
  expect(screen.getByText('Cloud one')).toBeVisible()
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  expect(onChange).not.toHaveBeenCalled()
})
