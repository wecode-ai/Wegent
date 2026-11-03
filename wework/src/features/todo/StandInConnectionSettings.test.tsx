import { newStandInRole } from '@/api/personalStandIn'
import '@/i18n'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { StandInConnectionSettings } from './StandInConnectionSettings'

const props = {
  role: newStandInRole('mac'),
  projects: [],
  deviceId: 'mac',
  localDeviceId: 'mac',
  disabled: false,
  onChange: vi.fn(),
}

it('offers the built-in calendar once rather than adding a second calendar connection', async () => {
  const user = userEvent.setup()
  render(<StandInConnectionSettings {...props} scheduling={{ userId: 7, roleId: '@primary' }} />)
  expect(screen.getAllByText('日历')).toHaveLength(1)
  expect(screen.queryByTestId('stand-in-connections-empty')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('stand-in-add-connection'))
  expect(screen.getAllByText('日历')).toHaveLength(1)
  expect(screen.queryByTestId('stand-in-add-time-connection')).not.toBeInTheDocument()
})
