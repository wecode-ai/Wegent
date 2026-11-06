import { cleanup, render, screen } from '@testing-library/react'
import { useImperativeHandle, type Ref } from 'react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo, User } from '@/types/api'
import { LOCAL_USER } from '@/api/local/localSession'
import '@/i18n'
import { PersonalStandInWorkspace } from './PersonalStandInWorkspace'
import type { StandInSettingsHandle } from './StandInSettingsPage'

const guard = vi.hoisted(() => vi.fn((action: () => void) => action()))
afterEach(() => {
  cleanup()
  guard.mockReset()
  guard.mockImplementation(action => action())
})

vi.mock('./weworkPlatformApi', () => ({
  createWeworkPlatformApi: () => ({ projects: { list: async () => [] } }),
}))
vi.mock('./localWorkspaceApi', () => ({ createLocalWorkspaceApi: () => null }))
vi.mock('./StandInOverviewPage', () => ({
  StandInOverviewPage: ({
    initialProfileId,
    userId,
    initialDeviceId,
    ref,
  }: {
    initialProfileId: string
    userId: number
    initialDeviceId?: string
    ref: Ref<Pick<StandInSettingsHandle, 'requestLeave'>>
  }) => {
    useImperativeHandle(ref, () => ({ requestLeave: guard }))
    return (
      <input
        data-testid="retained-role-draft"
        data-owner={userId}
        data-device={initialDeviceId}
        defaultValue={initialProfileId}
      />
    )
  },
}))

it('keeps the owning tab identity and draft when another tab changes the browser query', async () => {
  const props = {
    services: {} as WorkbenchServices,
    user: { id: 7, user_name: 'owner' } as unknown as User,
    devices: [],
    contentRoute: '/stand-in?profileId=reviewer&deviceId=device-a',
    onClose: vi.fn(),
    onOpenTask: vi.fn(),
  }
  const original = window.location.href
  const view = render(<PersonalStandInWorkspace {...props} active />)
  const field = screen.getByTestId('retained-role-draft')
  await userEvent.type(field, ' unsaved')
  try {
    window.history.replaceState({}, '', '/plugins?workspaceTab=plugins')
    view.rerender(<PersonalStandInWorkspace {...props} active={false} />)
    expect(screen.getByTestId('retained-role-draft')).toBe(field)
    expect(field).toHaveValue('reviewer unsaved')
    window.history.replaceState({}, '', '/stand-in?profileId=reviewer&deviceId=device-a')
    view.rerender(<PersonalStandInWorkspace {...props} active />)
    expect(screen.getByTestId('retained-role-draft')).toBe(field)
    expect(field).toHaveValue('reviewer unsaved')
  } finally {
    window.history.replaceState({}, '', original)
  }
})

it('keeps signed-out local profiles reachable after connecting and separates cloud owners', async () => {
  const props = {
    services: {
      getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'mac' }),
    } as WorkbenchServices,
    user: LOCAL_USER as User,
    devices: [] as DeviceInfo[],
    active: true,
    contentRoute: '/stand-in',
    onClose: vi.fn(),
    onOpenTask: vi.fn(),
  }
  const view = render(<PersonalStandInWorkspace {...props} />)
  const picker = await screen.findByTestId('stand-in-workspace-location')
  expect(screen.getByTestId('retained-role-draft')).toHaveAttribute('data-owner', '0')
  view.rerender(
    <PersonalStandInWorkspace
      {...props}
      user={{ id: 7, user_name: 'cloud' } as User}
      devices={[
        {
          device_id: 'cloud-one',
          device_type: 'cloud',
          name: 'Cloud one',
          status: 'online',
        } as DeviceInfo,
      ]}
    />
  )
  await userEvent.selectOptions(picker, '@local')
  expect(screen.getByTestId('retained-role-draft')).toHaveAttribute('data-owner', '0')
  expect(screen.getByTestId('retained-role-draft')).toHaveAttribute('data-device', 'mac')
  await userEvent.selectOptions(picker, 'cloud-one')
  expect(screen.getByTestId('retained-role-draft')).toHaveAttribute('data-owner', '7')
  expect(screen.getByTestId('retained-role-draft')).toHaveAttribute('data-device', 'cloud-one')
  await userEvent.selectOptions(picker, '@local')
  expect(screen.getByTestId('retained-role-draft')).toHaveAttribute('data-owner', '0')
  expect(screen.getByTestId('retained-role-draft')).toHaveAttribute('data-device', 'mac')
})

it('guards location changes with the existing unsaved settings decision', async () => {
  render(
    <PersonalStandInWorkspace
      services={
        { getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'mac' }) } as WorkbenchServices
      }
      user={{ id: 7 } as User}
      devices={[]}
      active
      contentRoute="/stand-in"
      onClose={vi.fn()}
      onOpenTask={vi.fn()}
    />
  )
  const picker = await screen.findByTestId('stand-in-workspace-location')
  guard.mockImplementation(() => {})
  await userEvent.selectOptions(picker, '@local')
  expect(guard).toHaveBeenCalledOnce()
  expect(screen.getByTestId('retained-role-draft')).toHaveAttribute('data-owner', '7')
})
