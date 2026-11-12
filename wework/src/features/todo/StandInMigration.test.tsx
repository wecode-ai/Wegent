import '@/i18n'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { DeviceInfo } from '@/types/api'
import { StandInMigration } from './StandInMigration'
import { newStandInRole } from '@/api/personalStandIn'

afterEach(cleanup)
const props = () => ({
  devices: [
    { device_id: 'cloud', device_type: 'cloud', name: 'Cloud', status: 'online' } as DeviceInfo,
  ],
  sourceDevice: 'mac',
  roles: [{ ...newStandInRole('mac', 'review'), name: 'Reviewer' }],
  busy: false,
  onMigrate: vi.fn<(device: string, role?: string) => Promise<void>>().mockResolvedValue(undefined),
})

test('asks for confirmation and cancellation never transfers any data', async () => {
  const p = props()
  render(<StandInMigration {...p} />)
  fireEvent.click(screen.getByTestId('stand-in-migrate-open'))
  expect(await screen.findByTestId('stand-in-migrate-confirm')).toBeEnabled()
  fireEvent.click(screen.getByTestId('stand-in-migrate-cancel'))
  expect(p.onMigrate).not.toHaveBeenCalled()
  expect(screen.queryByTestId('stand-in-migrate-confirm')).toBeNull()
  fireEvent.click(screen.getByTestId('stand-in-migrate-keep-local'))
  expect(screen.queryByTestId('stand-in-migration')).toBeNull()
})

test('waits for transfer and binding completion for the selected profile', async () => {
  let complete!: () => void
  const p = props()
  p.onMigrate.mockImplementation(
    () =>
      new Promise(resolve => {
        complete = resolve
      })
  )
  render(<StandInMigration {...p} />)
  fireEvent.change(screen.getByTestId('stand-in-migration-role'), { target: { value: 'review' } })
  fireEvent.click(screen.getByTestId('stand-in-migrate-open'))
  fireEvent.click(screen.getByTestId('stand-in-migrate-confirm'))
  expect(p.onMigrate).toHaveBeenCalledWith('cloud', 'review')
  expect(screen.getByTestId('stand-in-migrate-confirm')).toBeDisabled()
  complete()
  await waitFor(() => expect(screen.queryByTestId('stand-in-migrate-confirm')).toBeNull())
})

test('failed migration stays on the stopped source with a visible retry', async () => {
  const p = props()
  p.onMigrate.mockRejectedValue(new Error('Executor offline'))
  render(<StandInMigration {...p} />)
  fireEvent.click(screen.getByTestId('stand-in-migrate-open'))
  fireEvent.click(screen.getByTestId('stand-in-migrate-confirm'))
  await screen.findByRole('alert')
  expect(screen.getByTestId('stand-in-migrate-open')).toBeEnabled()
})

test('disables migration controls during another instance transition', () => {
  render(<StandInMigration {...props()} busy />)
  expect(screen.getByTestId('stand-in-migration-device')).toBeDisabled()
  expect(screen.getByTestId('stand-in-migration-role')).toBeDisabled()
  expect(screen.getByTestId('stand-in-migrate-open')).toBeDisabled()
})
