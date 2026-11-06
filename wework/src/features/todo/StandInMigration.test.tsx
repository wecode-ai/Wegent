import '@/i18n'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { StandInExecutorApi } from '@/api/standIn'
import type { DeviceInfo } from '@/types/api'
import { StandInMigration } from './StandInMigration'
import { migrateStandIn } from './migrateStandIn'
import { newStandInRole } from '@/api/personalStandIn'

vi.mock('./migrateStandIn', async original => ({
  ...(await original<typeof import('./migrateStandIn')>()),
  migrateStandIn: vi.fn(),
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
const props = () => ({
  api: {} as StandInExecutorApi,
  devices: [
    { device_id: 'cloud', device_type: 'cloud', name: 'Cloud', status: 'online' } as DeviceInfo,
  ],
  sourceUser: 0,
  sourceDevice: 'mac',
  roleId: 'local-role',
  targetUser: 7,
  requestLeave: (action: () => void) => action(),
  onMigrated: vi.fn(),
})

test('asks for confirmation and cancellation never transfers any data', async () => {
  render(<StandInMigration {...props()} />)
  fireEvent.click(screen.getByTestId('stand-in-migrate-open'))
  expect(await screen.findByTestId('stand-in-migrate-confirm')).toBeEnabled()
  fireEvent.click(screen.getByTestId('stand-in-migrate-cancel'))
  expect(migrateStandIn).not.toHaveBeenCalled()
  expect(screen.queryByTestId('stand-in-migrate-confirm')).toBeNull()
  fireEvent.click(screen.getByTestId('stand-in-migrate-keep-local'))
  expect(screen.queryByTestId('stand-in-migration')).toBeNull()
})

test('opens the migrated role on the selected cloud device only after completion', async () => {
  let complete!: (role: ReturnType<typeof newStandInRole>) => void
  vi.mocked(migrateStandIn).mockReturnValue(
    new Promise(resolve => {
      complete = resolve
    })
  )
  const p = props()
  render(<StandInMigration {...p} />)
  fireEvent.click(screen.getByTestId('stand-in-migrate-open'))
  fireEvent.click(screen.getByTestId('stand-in-migrate-confirm'))
  expect(screen.getByTestId('stand-in-migrate-confirm')).toBeDisabled()
  expect(p.onMigrated).not.toHaveBeenCalled()
  complete(newStandInRole('cloud', 'migrated-role'))
  await waitFor(() => expect(p.onMigrated).toHaveBeenCalledWith('cloud', 'migrated-role'))
  expect(migrateStandIn).toHaveBeenCalledWith(
    p.api,
    expect.objectContaining({
      sourceUser: 0,
      sourceDevice: 'mac',
      roleId: 'local-role',
      targetUser: 7,
      targetDevice: 'cloud',
    })
  )
})

test('a failed migration stays on the local profile with an explicit retry entry', async () => {
  vi.mocked(migrateStandIn).mockRejectedValue(new Error('Executor offline'))
  const p = props()
  render(<StandInMigration {...p} />)
  fireEvent.click(screen.getByTestId('stand-in-migrate-open'))
  fireEvent.click(screen.getByTestId('stand-in-migrate-confirm'))
  await screen.findByRole('alert')
  expect(p.onMigrated).not.toHaveBeenCalled()
  expect(screen.getByTestId('stand-in-migrate-open')).toBeEnabled()
})
