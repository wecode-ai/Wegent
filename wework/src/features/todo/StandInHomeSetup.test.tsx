import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { StandInExecutorApi } from '@/api/standIn'
import { StandInHomeSetup, StandInHomeSetupPrompt } from './StandInHomeSetup'
import i18n from '@/i18n'

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@/lib/navigation', () => ({ navigateTo: navigate }))
afterEach(() => {
  cleanup()
  navigate.mockClear()
})

it('guides users to connect a board rather than treating assistant creation as completion', async () => {
  await i18n.changeLanguage('en')
  render(<StandInHomeSetupPrompt />)
  expect(screen.getByText('Connect a board so your assistant can help')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('personal-home-setup-assistant'))
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/stand-in')
})

it('recovers settings reads and gives the saved roles and board connections to the work list', async () => {
  const settings = {
    userId: 7,
    executionDeviceId: 'bound',
    primary: { enabled: true },
    roles: [],
    version: 1,
  }
  const personalGet = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(settings)
  const children = vi.fn(() => <div>Existing work list</div>)
  render(
    <StandInHomeSetup
      api={{ personalGet } as unknown as StandInExecutorApi}
      userId={7}
      deviceId="bound"
      active
    >
      {children}
    </StandInHomeSetup>
  )
  fireEvent.click(await screen.findByTestId('personal-home-setup-retry'))
  await screen.findByText('Existing work list')
  expect(children).toHaveBeenCalledWith(settings)
  expect(personalGet).toHaveBeenCalledWith(7, 'bound')
})

it('keeps the current work list and its draft mounted when a refresh fails', async () => {
  const settings = {
    userId: 7,
    executionDeviceId: 'bound',
    primary: { enabled: true },
    roles: [],
    version: 1,
  }
  const personalGet = vi
    .fn()
    .mockResolvedValueOnce(settings)
    .mockRejectedValueOnce(new Error('offline'))
  const api = { personalGet } as unknown as StandInExecutorApi
  const panel = (active: boolean) => (
    <StandInHomeSetup api={api} userId={7} deviceId="bound" active={active}>
      {() => <input aria-label="Work draft" defaultValue="Keep this" />}
    </StandInHomeSetup>
  )
  const { rerender } = render(panel(true))
  const input = await screen.findByLabelText('Work draft')
  rerender(panel(false))
  rerender(panel(true))
  await screen.findByRole('alert')
  expect(screen.getByLabelText('Work draft')).toBe(input)
  expect(input).toHaveValue('Keep this')
})
