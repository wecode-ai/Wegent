import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useImperativeHandle, type Ref } from 'react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo, User } from '@/types/api'
import { LOCAL_USER } from '@/api/local/localSession'
import { newStandInRole } from '@/api/personalStandIn'
import '@/i18n'
import { PersonalStandInWorkspace } from './PersonalStandInWorkspace'
import type { StandInSettingsHandle } from './StandInSettingsPage'

const guard = vi.hoisted(() => vi.fn((action: () => void) => action()))
afterEach(() => {
  cleanup()
  localStorage.clear()
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
    initialSelectedRoleId,
    onSelectLocation,
    userId,
    initialDeviceId,
    ref,
  }: {
    initialProfileId: string
    initialSelectedRoleId?: string
    onSelectLocation: (deviceId: string, roleId?: string, openSettings?: boolean) => void
    userId: number
    initialDeviceId?: string
    ref: Ref<Pick<StandInSettingsHandle, 'requestLeave'>>
  }) => {
    useImperativeHandle(ref, () => ({ requestLeave: guard }))
    return (
      <>
        <button
          data-testid="save-role-on-cloud"
          onClick={() => onSelectLocation('cloud-one', 'reviewer')}
        >
          Save
        </button>
        <input
          data-testid="retained-role-draft"
          data-owner={userId}
          data-device={initialDeviceId}
          data-role={initialSelectedRoleId}
          defaultValue={initialProfileId}
        />
      </>
    )
  },
}))

it('retains the saved role when changing device without reopening its settings', async () => {
  render(
    <PersonalStandInWorkspace
      services={{} as WorkbenchServices}
      user={{ id: 7 } as User}
      devices={[]}
      active
      contentRoute="/stand-in?profileId=reviewer&deviceId=mac"
      onClose={vi.fn()}
      onOpenTask={vi.fn()}
    />
  )
  await userEvent.click(screen.getByTestId('save-role-on-cloud'))
  const field = screen.getByTestId('retained-role-draft')
  expect(field).toHaveAttribute('data-device', 'cloud-one')
  expect(field).toHaveAttribute('data-role', 'reviewer')
  expect(field).toHaveValue('')
})

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
  await screen.findByTestId('stand-in-workspace-location')
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
  const picker = await screen.findByTestId('stand-in-workspace-location')
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

it.each([
  { existing: -1, owner: '7', device: 'cloud-one' },
  { existing: 0, owner: '0', device: 'mac' },
  { existing: 7, owner: '7', device: 'mac' },
])(
  'resolves first-use to $device for owner $owner while preserving existing local profiles',
  async ({ existing, owner, device }) => {
    const personalGet = vi.fn(async (userId: number) => ({
      userId,
      executionDeviceId: 'mac',
      version: userId === existing ? 1 : 0,
      roles: [newStandInRole('mac', 'default')],
      primary: { enabled: userId === existing, prompt: '', preferences: '' },
    }))
    const services = {
      getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'mac' }),
      standInApi: { personalGet },
    } as unknown as WorkbenchServices
    const { CloudConnectionContext } =
      await import('@/features/cloud-connection/CloudConnectionContext')
    render(
      <CloudConnectionContext.Provider
        value={
          {
            isConnected: true,
          } as import('@/features/cloud-connection/CloudConnectionContext').CloudConnectionContextValue
        }
      >
        <PersonalStandInWorkspace
          services={services}
          user={{ id: 7 } as User}
          devices={[
            {
              device_id: 'cloud-one',
              device_type: 'cloud',
              name: 'Cloud one',
              status: 'online',
            } as DeviceInfo,
          ]}
          active
          contentRoute="/stand-in"
          onClose={vi.fn()}
          onOpenTask={vi.fn()}
        />
      </CloudConnectionContext.Provider>
    )
    const field = await screen.findByTestId('retained-role-draft')
    expect(field).toHaveAttribute('data-owner', owner)
    expect(field).toHaveAttribute('data-device', device)
  }
)

it('does not discover profiles for an inactive workspace', async () => {
  const identity = vi.fn(async () => ({ deviceId: 'mac' }))
  const p = {
    services: { getLocalRuntimeSidebarIdentity: identity } as unknown as WorkbenchServices,
    user: LOCAL_USER as User,
    devices: [],
    contentRoute: '/stand-in',
    onClose: vi.fn(),
    onOpenTask: vi.fn(),
  }
  const view = render(<PersonalStandInWorkspace {...p} active={false} />)
  expect(identity).not.toHaveBeenCalled()
  view.rerender(<PersonalStandInWorkspace {...p} active />)
  await screen.findByTestId('stand-in-workspace-location')
  expect(identity).toHaveBeenCalledOnce()
})

it('remembers the explicitly selected cloud profile without sharing it with another account', async () => {
  const p = {
    services: {
      getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'mac' }),
    } as WorkbenchServices,
    user: { id: 7 } as User,
    devices: [
      {
        device_id: 'cloud-one',
        device_type: 'cloud',
        status: 'online',
        name: 'Cloud',
      } as DeviceInfo,
    ],
    active: true,
    contentRoute: '/stand-in',
    onClose: vi.fn(),
    onOpenTask: vi.fn(),
  }
  let view = render(<PersonalStandInWorkspace {...p} />)
  await userEvent.selectOptions(
    await screen.findByTestId('stand-in-workspace-location'),
    'cloud-one'
  )
  view.unmount()
  view = render(<PersonalStandInWorkspace {...p} />)
  expect(await screen.findByTestId('retained-role-draft')).toHaveAttribute(
    'data-device',
    'cloud-one'
  )
  view.unmount()
  render(<PersonalStandInWorkspace {...p} user={{ id: 8 } as User} />)
  expect(await screen.findByTestId('retained-role-draft')).toHaveAttribute('data-device', 'mac')
})

it('keeps a failed local profile discovery visible after project loading and retries that discovery', async () => {
  let localReads = 0
  const personalGet = vi.fn(async (userId: number) => {
    if (userId === 0 && localReads++ === 0) throw new Error('Executor offline')
    return { userId, executionDeviceId: 'mac', version: 0, roles: [] }
  })
  const services = {
    getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'mac' }),
    standInApi: { personalGet },
  } as unknown as WorkbenchServices
  render(
    <PersonalStandInWorkspace
      services={services}
      user={{ id: 7 } as User}
      devices={[]}
      active
      contentRoute="/stand-in"
      onClose={vi.fn()}
      onOpenTask={vi.fn()}
    />
  )
  await screen.findByRole('alert')
  expect(screen.queryByTestId('retained-role-draft')).toBeNull()
  await userEvent.click(screen.getByTestId('stand-in-project-catalog-retry'))
  expect(await screen.findByTestId('retained-role-draft')).toHaveAttribute('data-device', 'mac')
  expect(localReads).toBe(2)
  expect(screen.queryByRole('alert')).toBeNull()
})

it('reloads scoped preferences when the enterprise user or Backend resolves without remounting', async () => {
  const { CloudConnectionContext } =
    await import('@/features/cloud-connection/CloudConnectionContext')
  const key = (backend: string, account: number) =>
    `wework.stand-in.cloud-device:${JSON.stringify([backend, account])}`
  localStorage.setItem(key('https://enterprise-a', 7), 'cloud-one')
  localStorage.setItem(key('https://enterprise-b', 7), 'cloud-two')
  const services = {
    getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'mac' }),
    standInApi: {
      personalGet: async (userId: number) => ({ userId, version: userId === 0 ? 1 : 0, roles: [] }),
    },
  } as unknown as WorkbenchServices
  const workspace = (user: User, backend: string) => (
    <CloudConnectionContext.Provider
      value={
        {
          isConnected: true,
          apiBaseUrl: backend,
        } as import('@/features/cloud-connection/CloudConnectionContext').CloudConnectionContextValue
      }
    >
      <PersonalStandInWorkspace
        services={services}
        user={user}
        devices={[]}
        active
        contentRoute="/stand-in"
        onClose={vi.fn()}
        onOpenTask={vi.fn()}
      />
    </CloudConnectionContext.Provider>
  )
  const view = render(workspace(LOCAL_USER as User, 'https://enterprise-a'))
  expect(await screen.findByTestId('retained-role-draft')).toHaveAttribute('data-device', 'mac')
  view.rerender(workspace({ id: 7 } as User, 'https://enterprise-a'))
  await waitFor(() =>
    expect(screen.getByTestId('retained-role-draft')).toHaveAttribute('data-device', 'cloud-one')
  )
  expect(screen.getByTestId('retained-role-draft')).toHaveAttribute('data-owner', '7')
  view.rerender(workspace({ id: 8 } as User, 'https://enterprise-a'))
  await waitFor(() =>
    expect(screen.getByTestId('retained-role-draft')).toHaveAttribute('data-device', 'mac')
  )
  expect(screen.getByTestId('retained-role-draft')).toHaveAttribute('data-owner', '0')
  view.rerender(workspace({ id: 7 } as User, 'https://enterprise-b'))
  await waitFor(() =>
    expect(screen.getByTestId('retained-role-draft')).toHaveAttribute('data-device', 'cloud-two')
  )
  expect(screen.getByTestId('retained-role-draft')).toHaveAttribute('data-owner', '7')
})
