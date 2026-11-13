import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { useImperativeHandle, type ReactNode, type Ref } from 'react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo, User } from '@/types/api'
import type { StandInBindingTarget, StandInInstanceBinding } from '@/api/standIn'
import {
  CloudConnectionContext,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'
import i18n from '@/i18n'
import { PersonalStandInWorkspace } from './PersonalStandInWorkspace'
import type { StandInSettingsHandle } from './StandInSettingsPage'
import * as migration from './migrateStandIn'
import { newStandInRole } from '@/api/personalStandIn'
import { WORKSPACE_NAVIGATION_EVENT } from '@/lib/navigation'

const guard = vi.hoisted(() => vi.fn((action: () => void) => action()))
const projectList = vi.hoisted(() => vi.fn(async () => []))
const projectCatalog = vi.hoisted(() => ({ available: true }))
afterEach(() => {
  cleanup()
  localStorage.clear()
  guard.mockReset()
  guard.mockImplementation(action => action())
  projectList.mockReset()
  projectList.mockResolvedValue([])
  projectCatalog.available = true
})
vi.mock('./weworkPlatformApi', () => ({
  createWeworkPlatformApi: () =>
    projectCatalog.available ? { projects: { list: projectList } } : null,
}))
vi.mock('./localWorkspaceApi', () => ({ createLocalWorkspaceApi: () => null }))
vi.mock('./StandInHomeSetup', () => ({
  StandInHomeSetup: ({ children }: { children: (settings: unknown) => React.ReactNode }) =>
    children({}),
  StandInHomeSetupPrompt: () => <div>Set up assistant</div>,
}))
vi.mock('./StandInHomeWorkspace', () => ({
  StandInHomeWorkspace: ({ userId, deviceId }: { userId: number; deviceId: string }) => (
    <div data-testid="embedded-stand-in" data-owner={userId} data-device={deviceId} />
  ),
}))
vi.mock('./StandInOverviewPage', () => ({
  StandInOverviewPage: ({
    userId,
    initialDeviceId,
    initialProfileId,
    initialSelectedRoleId,
    headerActions,
    onSelectLocation,
    ref,
  }: {
    userId: number
    initialDeviceId: string
    initialProfileId?: string
    initialSelectedRoleId?: string
    headerActions: ReactNode
    onSelectLocation(device: string): void
    ref: Ref<Pick<StandInSettingsHandle, 'requestLeave'>>
  }) => {
    useImperativeHandle(ref, () => ({ requestLeave: guard }))
    return (
      <>
        <header>{headerActions}</header>
        <input
          data-testid="retained-role-draft"
          data-owner={userId}
          data-device={initialDeviceId}
          defaultValue={initialProfileId ?? initialSelectedRoleId}
        />
        <button data-testid="legacy-change-device" onClick={() => onSelectLocation('cloud-one')}>
          Legacy callback
        </button>
      </>
    )
  },
}))

function fixture(
  initial: StandInInstanceBinding = {
    version: 1,
    status: 'active',
    target: { userId: 7, deviceId: 'mac' },
  },
  backendUrl = ''
) {
  let current = initial
  const binding = vi.fn(
    async (_device: string, operation = 'get', version?: number, target?: StandInBindingTarget) => {
      if (operation === 'get') return current
      if (current.version !== version) throw new Error('version conflict')
      current = {
        version: current.version + 1,
        status:
          operation === 'bind' ? 'active' : operation === 'beginStop' ? 'stopping' : 'stopped',
        target: target ?? current.target,
      }
      return current
    }
  )
  const lifecycle = vi.fn(
    async (_userId: number, _deviceId: string, operation: 'start' | 'stop') => ({
      userId: 7,
      executionDeviceId: 'mac',
      version: 1,
      roles: [],
      lifecycle: operation === 'stop' ? { status: 'stopped' as const } : undefined,
    })
  )
  const identity = vi.fn(async () => ({ deviceId: 'mac' }))
  const personalGet = vi.fn(async (userId: number) => ({
    userId,
    executionDeviceId: 'mac',
    version: 1,
    roles: [],
  }))
  const props = {
    services: {
      getLocalRuntimeSidebarIdentity: identity,
      standInApi: { binding, lifecycle, personalGet },
    } as unknown as WorkbenchServices,
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
    entryRequestKey: 0,
    contentRoute: '/stand-in',
    onClose: vi.fn(),
    onOpenTask: vi.fn(),
  }
  const workspace = (changes: Partial<typeof props> = {}) => (
    <CloudConnectionContext.Provider
      value={{ isConnected: true, apiBaseUrl: backendUrl } as CloudConnectionContextValue}
    >
      <PersonalStandInWorkspace {...props} {...changes} />
    </CloudConnectionContext.Provider>
  )
  return { props, workspace, binding, lifecycle, identity, personalGet }
}

it('embeds the bound personal conversation without loading the project catalog or role directory', async () => {
  projectCatalog.available = false
  const f = fixture()
  render(<PersonalStandInWorkspace {...f.props} embedded />)
  const conversation = await screen.findByTestId('embedded-stand-in')
  expect(conversation).toHaveAttribute('data-owner', '7')
  expect(conversation).toHaveAttribute('data-device', 'mac')
  expect(projectList).not.toHaveBeenCalled()
  expect(screen.queryByTestId('retained-role-draft')).not.toBeInTheDocument()
})

it('reads the authoritative primary binding again when the workspace is explicitly reopened', async () => {
  const f = fixture()
  const view = render(f.workspace())
  await waitFor(() =>
    expect(screen.getByTestId('retained-role-draft')).toHaveAttribute('data-device', 'mac')
  )
  f.binding.mockResolvedValue({
    version: 4,
    status: 'active',
    target: { userId: 7, deviceId: 'cloud-one' },
  })
  view.rerender(f.workspace({ entryRequestKey: 1 }))
  await waitFor(() =>
    expect(screen.getByTestId('retained-role-draft')).toHaveAttribute('data-device', 'cloud-one')
  )
  expect(f.lifecycle).not.toHaveBeenCalled()
  expect(f.binding).toHaveBeenCalledTimes(2)
})

it('refreshes native data when the active page is opened again at the same route', async () => {
  const f = fixture()
  render(f.workspace())
  await screen.findByTestId('retained-role-draft')
  const reads = f.personalGet.mock.calls.length
  act(() => {
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_NAVIGATION_EVENT, {
        detail: { kind: 'task', contentRoute: '/stand-in' },
      })
    )
  })
  await waitFor(() => expect(f.binding).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(f.personalGet.mock.calls.length).toBeGreaterThan(reads))
  expect(f.lifecycle).not.toHaveBeenCalled()
})

it('does not report another account while the instance binding is still unknown', async () => {
  const backendUrl = 'https://cloud.example.test/api/v1'
  const f = fixture(undefined, backendUrl)
  let resolve!: (value: StandInInstanceBinding) => void
  f.binding.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  render(f.workspace())
  await waitFor(() => expect(f.binding).toHaveBeenCalledOnce())
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toBeVisible()
  await act(async () =>
    resolve({ version: 1, status: 'active', target: { userId: 7, deviceId: 'mac', backendUrl } })
  )
  expect(await screen.findByTestId('retained-role-draft')).toBeVisible()
})

it('does not open a notification conversation under a different bound owner', async () => {
  const f = fixture()
  render(f.workspace({ contentRoute: '/stand-in?deviceId=mac&userId=999&profileId=@primary' }))
  await screen.findByRole('alert')
  expect(screen.queryByTestId('retained-role-draft')).not.toBeInTheDocument()
})

it('discovers account and local profiles concurrently before selecting the initial owner', async () => {
  const f = fixture({ version: 0, status: 'unbound', target: null })
  let finish!: () => void
  f.personalGet.mockImplementationOnce(
    userId =>
      new Promise(done => {
        finish = () => done({ userId, executionDeviceId: 'mac', version: 1, roles: [] })
      })
  )
  render(f.workspace())
  await waitFor(() => expect(f.personalGet).toHaveBeenCalledTimes(2))
  expect(f.binding).toHaveBeenCalledOnce()
  expect(f.lifecycle).not.toHaveBeenCalled()
  await act(async () => finish())
  expect(await screen.findByTestId('retained-role-draft')).toHaveAttribute('data-owner', '7')
})

it.each(['/stand-in', '/stand-in?deviceId=mac'])(
  'shares the first binding transaction when device discovery refreshes before bind completes: %s',
  async contentRoute => {
    const f = fixture({ version: 0, status: 'unbound', target: null })
    const original = f.binding.getMockImplementation()!
    let finish!: () => void
    f.binding.mockImplementation((...args) => {
      if (args[1] !== 'bind') return original(...args)
      return new Promise((resolve, reject) => {
        finish = () => {
          void original(...args).then(resolve, reject)
        }
      })
    })
    const view = render(f.workspace({ contentRoute }))
    await waitFor(() =>
      expect(f.binding.mock.calls.filter(call => call[1] === 'bind')).toHaveLength(1)
    )
    view.rerender(f.workspace({ contentRoute, devices: [...f.props.devices] }))
    await waitFor(() => expect(f.binding.mock.calls.filter(call => !call[1])).toHaveLength(2))
    await act(async () => finish())
    expect(await screen.findByTestId('retained-role-draft')).toBeVisible()
    expect(f.binding.mock.calls.filter(call => call[1] === 'bind')).toHaveLength(1)
    expect(f.lifecycle).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  }
)

async function confirmStop() {
  await userEvent.click(await screen.findByTestId('stand-in-instance-stop'))
  await userEvent.click(screen.getByTestId('stand-in-instance-stop-confirm'))
}

it('leaves the previous role location after stopping and binding a different primary device', async () => {
  const f = fixture()
  render(f.workspace({ contentRoute: '/stand-in?deviceId=mac&profileId=review' }))
  expect(await screen.findByTestId('retained-role-draft')).toHaveAttribute('data-device', 'mac')
  await confirmStop()
  await userEvent.click(await screen.findByTestId('stand-in-instance-bind-7-cloud-one'))
  await waitFor(() =>
    expect(screen.getByTestId('retained-role-draft')).toHaveAttribute('data-device', 'cloud-one')
  )
})

it('keeps the primary binding while following an explicit role on another device', async () => {
  const f = fixture()
  const view = render(f.workspace())
  const field = await screen.findByTestId('retained-role-draft')
  expect(screen.queryByTestId('stand-in-workspace-location')).not.toBeInTheDocument()
  expect(screen.getByTestId('stand-in-instance-stop').closest('header')).not.toBeNull()
  await userEvent.click(screen.getByTestId('legacy-change-device'))
  expect(field).toHaveAttribute('data-device', 'mac')
  expect(f.binding).toHaveBeenCalledTimes(1)
  await act(async () =>
    view.rerender(f.workspace({ contentRoute: '/stand-in?deviceId=cloud-one&profileId=other' }))
  )
  await waitFor(() => expect(screen.getByTestId('retained-role-draft')).toHaveValue('other'))
  expect(screen.getByTestId('retained-role-draft')).toHaveAttribute('data-device', 'cloud-one')
  expect(f.binding).toHaveBeenCalledTimes(1)
})

it('honors an explicit project link only while establishing the first instance binding', async () => {
  const f = fixture({ version: 0, status: 'unbound', target: null })
  f.personalGet.mockImplementation(async userId => ({
    userId,
    executionDeviceId: 'mac',
    version: 0,
    roles: [],
  }))
  render(f.workspace({ contentRoute: '/stand-in?profileId=default&deviceId=mac' }))
  const field = await screen.findByTestId('retained-role-draft')
  expect(field).toHaveAttribute('data-device', 'mac')
  expect(field).toHaveValue('default')
  expect(f.binding).toHaveBeenCalledWith('mac', 'bind', 0, {
    userId: 7,
    deviceId: 'mac',
    backendUrl: '',
  })
})

it.each(['zh-CN', 'en'])(
  'preserves the localized stop-before-rebinding guidance in %s',
  async language => {
    const originalLanguage = i18n.language
    try {
      await i18n.changeLanguage(language)
      const f = fixture()
      render(f.workspace())
      await userEvent.click(await screen.findByTestId('legacy-change-device'))
      expect(screen.getByRole('alert')).toHaveTextContent(
        i18n.t('common:standIn.instance.stop_before_rebind')
      )
      expect(screen.queryByTestId('stand-in-view-devices')).not.toBeInTheDocument()
      expect(f.binding).toHaveBeenCalledOnce()
    } finally {
      cleanup()
      await i18n.changeLanguage(originalLanguage)
    }
  }
)

it('never stops a different binding that changed while its confirmation was open', async () => {
  const f = fixture()
  const view = render(f.workspace())
  await userEvent.click(await screen.findByTestId('stand-in-instance-stop'))
  await f.binding('mac', 'beginStop', 1)
  await f.binding('mac', 'completeStop', 2)
  await f.binding('mac', 'bind', 3, { userId: 7, deviceId: 'cloud-one' })
  view.rerender(f.workspace({ devices: [...f.props.devices] }))
  await waitFor(() =>
    expect(screen.getByTestId('retained-role-draft')).toHaveAttribute('data-device', 'cloud-one')
  )
  await userEvent.click(screen.getByTestId('stand-in-instance-stop-confirm'))
  expect(await screen.findByRole('alert')).toHaveTextContent('其他位置更新')
  expect(f.lifecycle).not.toHaveBeenCalled()
})

it('cancels the entire bound profile before offering another local or cloud binding', async () => {
  const f = fixture()
  let finish!: () => void
  f.lifecycle.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = () =>
          resolve({
            userId: 7,
            executionDeviceId: 'mac',
            version: 2,
            roles: [],
            lifecycle: { status: 'stopped' },
          })
      })
  )
  render(f.workspace())
  await confirmStop()
  expect(await screen.findByTestId('stand-in-instance-stopping')).toBeVisible()
  expect(screen.queryByTestId('stand-in-instance-bind-7-cloud-one')).not.toBeInTheDocument()
  expect(f.lifecycle).toHaveBeenCalledWith(7, 'mac', 'stop')
  finish()
  await userEvent.click(await screen.findByTestId('stand-in-instance-bind-7-cloud-one'))
  await waitFor(() => expect(f.lifecycle).toHaveBeenLastCalledWith(7, 'cloud-one', 'start'))
  expect(await screen.findByTestId('retained-role-draft')).toHaveAttribute(
    'data-device',
    'cloud-one'
  )
  expect(f.binding.mock.calls.map(call => call[1] ?? 'get')).toEqual([
    'get',
    'beginStop',
    'completeStop',
    'bind',
  ])
})

it('keeps failed cancellation locked and retries the same binding before rebinding', async () => {
  const f = fixture()
  f.lifecycle.mockRejectedValueOnce(new Error('Executor offline'))
  render(f.workspace())
  await confirmStop()
  expect(await screen.findByRole('alert')).toBeVisible()
  expect(screen.getByTestId('stand-in-instance-stopping')).toBeVisible()
  expect(screen.queryByTestId('stand-in-instance-bind-7-cloud-one')).not.toBeInTheDocument()
  expect(f.binding.mock.calls.some(call => call[1] === 'completeStop')).toBe(false)
  await confirmStop()
  expect(await screen.findByTestId('stand-in-instance-stopped')).toBeVisible()
  expect(f.lifecycle.mock.calls).toEqual([
    [7, 'mac', 'stop'],
    [7, 'mac', 'stop'],
  ])
})

it('requires an explicit stopped acknowledgement before unlocking binding choices', async () => {
  const f = fixture()
  f.lifecycle.mockResolvedValueOnce({
    userId: 7,
    executionDeviceId: 'mac',
    version: 2,
    roles: [],
    lifecycle: undefined,
  })
  render(f.workspace())
  await confirmStop()
  expect(await screen.findByRole('alert')).toHaveTextContent('任务尚未完全停止')
  expect(screen.getByTestId('stand-in-instance-stopping')).toBeVisible()
  expect(f.binding.mock.calls.some(call => call[1] === 'completeStop')).toBe(false)
})

it('binds the prepared migration target only after portable transfer succeeds', async () => {
  const f = fixture({ version: 3, status: 'stopped', target: { userId: 7, deviceId: 'mac' } })
  const transfer = vi
    .spyOn(migration, 'migrateStandIn')
    .mockResolvedValueOnce(newStandInRole('cloud-one', 'imported'))
  const location = window.location.href
  try {
    render(f.workspace())
    await userEvent.click(await screen.findByTestId('stand-in-migrate-open'))
    await userEvent.click(screen.getByTestId('stand-in-migrate-confirm'))
    expect(await screen.findByTestId('retained-role-draft')).toHaveAttribute(
      'data-device',
      'cloud-one'
    )
    expect(transfer).toHaveBeenCalledOnce()
    expect(f.binding).toHaveBeenCalledWith('mac', 'bind', 3, {
      userId: 7,
      deviceId: 'cloud-one',
      backendUrl: '',
    })
    expect(f.lifecycle).toHaveBeenCalledExactlyOnceWith(7, 'cloud-one', 'start')
  } finally {
    transfer.mockRestore()
    window.history.replaceState({}, '', location)
  }
})

it('failed migration preparation keeps the source stopped and never binds or starts the target', async () => {
  const f = fixture({ version: 3, status: 'stopped', target: { userId: 7, deviceId: 'mac' } })
  const transfer = vi
    .spyOn(migration, 'migrateStandIn')
    .mockRejectedValueOnce(new Error('Executor offline'))
  try {
    render(f.workspace())
    await userEvent.click(await screen.findByTestId('stand-in-migrate-open'))
    await userEvent.click(screen.getByTestId('stand-in-migrate-confirm'))
    await waitFor(() =>
      expect(screen.queryByTestId('stand-in-migrate-confirm')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('stand-in-instance-stopped')).toBeVisible()
    expect(f.binding.mock.calls.every(call => !call[1])).toBe(true)
    expect(f.lifecycle).not.toHaveBeenCalled()
  } finally {
    transfer.mockRestore()
  }
})

it('keeps rebinding available when an already stopped source cannot load migration metadata', async () => {
  const f = fixture({ version: 3, status: 'stopped', target: { userId: 7, deviceId: 'cloud-one' } })
  f.personalGet.mockRejectedValueOnce(new Error('Executor offline'))
  render(f.workspace())
  expect(await screen.findByTestId('stand-in-instance-stopped')).toBeVisible()
  await screen.findByRole('alert')
  expect(screen.getByTestId('stand-in-instance-bind-7-mac')).toBeEnabled()
  expect(screen.queryByTestId('stand-in-migration')).not.toBeInTheDocument()
})

it('uses the existing unsaved-edit decision before stopping', async () => {
  const f = fixture()
  render(f.workspace())
  guard.mockImplementation(() => {})
  await userEvent.click(await screen.findByTestId('stand-in-instance-stop'))
  expect(guard).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(f.lifecycle).not.toHaveBeenCalled()
})

it('does not stop when the confirmation is cancelled', async () => {
  const f = fixture()
  render(f.workspace())
  await userEvent.click(await screen.findByTestId('stand-in-instance-stop'))
  await userEvent.click(screen.getByTestId('stand-in-instance-stop-cancel'))
  expect(f.lifecycle).not.toHaveBeenCalled()
  expect(screen.getByTestId('retained-role-draft')).toHaveAttribute('data-device', 'mac')
})

it('does not replace a durable binding when the account changes', async () => {
  const f = fixture()
  const view = render(f.workspace())
  await screen.findByTestId('retained-role-draft')
  view.rerender(f.workspace({ user: { id: 8 } as User }))
  expect(await screen.findByRole('alert')).toHaveTextContent('另一个账号')
  expect(screen.queryByTestId('retained-role-draft')).not.toBeInTheDocument()
  expect(f.lifecycle).not.toHaveBeenCalled()
  expect(f.binding.mock.calls.every(call => !call[1])).toBe(true)
})

it('retains the owning tab draft across unrelated browser navigation', async () => {
  const f = fixture()
  const view = render(f.workspace({ contentRoute: '/stand-in?profileId=reviewer' }))
  const field = await screen.findByTestId('retained-role-draft')
  await userEvent.type(field, ' unsaved')
  view.rerender(f.workspace({ active: false, contentRoute: '/stand-in?profileId=reviewer' }))
  view.rerender(f.workspace({ active: true, contentRoute: '/stand-in?profileId=reviewer' }))
  expect(screen.getByTestId('retained-role-draft')).toBe(field)
  expect(field).toHaveValue('reviewer unsaved')
})

it('does not discover or bind a profile for an inactive page', async () => {
  const f = fixture()
  const view = render(f.workspace({ active: false }))
  expect(f.identity).not.toHaveBeenCalled()
  view.rerender(f.workspace())
  await screen.findByTestId('retained-role-draft')
  expect(f.identity).toHaveBeenCalledOnce()
})

it('does not initialize a new binding when discovery finishes after the page becomes inactive', async () => {
  const f = fixture({ version: 0, status: 'unbound', target: null })
  let resolve!: (identity: { deviceId: string }) => void
  f.identity.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  const view = render(f.workspace())
  view.rerender(f.workspace({ active: false }))
  resolve({ deviceId: 'mac' })
  await waitFor(() => expect(f.binding).toHaveBeenCalledOnce())
  expect(f.binding.mock.calls[0][1]).toBeUndefined()
  expect(f.lifecycle).not.toHaveBeenCalled()
})

it('preserves a stopping binding across page remount and never resumes it automatically', async () => {
  const f = fixture({
    version: 2,
    status: 'stopping',
    target: { userId: 7, deviceId: 'cloud-one' },
  })
  render(f.workspace())
  expect(await screen.findByTestId('stand-in-instance-stopping')).toBeVisible()
  expect(f.lifecycle).not.toHaveBeenCalled()
  await confirmStop()
  expect(f.lifecycle).toHaveBeenCalledWith(7, 'cloud-one', 'stop')
  expect(await screen.findByTestId('stand-in-instance-stopped')).toBeVisible()
})

it('recovers initial binding discovery errors without opening another profile', async () => {
  const f = fixture()
  f.binding.mockRejectedValueOnce(new Error('Executor offline'))
  render(f.workspace())
  await screen.findByRole('alert')
  expect(screen.queryByTestId('stand-in-view-devices')).not.toBeInTheDocument()
  expect(screen.queryByTestId('retained-role-draft')).not.toBeInTheDocument()
  await userEvent.click(screen.getByTestId('stand-in-project-catalog-retry'))
  expect(await screen.findByTestId('retained-role-draft')).toHaveAttribute('data-device', 'mac')
})

it.each(['protocol_mismatch', 'unsupported_method'])(
  'shows an error and offers device status for %s without automatically navigating',
  async code => {
    const f = fixture()
    f.binding.mockRejectedValueOnce(Object.assign(new Error('private transport details'), { code }))
    const location = window.location.href
    try {
      render(f.workspace())
      const devices = await screen.findByTestId('stand-in-view-devices')
      expect(window.location.href).toBe(location)
      expect(screen.getByRole('alert')).toHaveTextContent('版本不兼容')
      expect(screen.getByRole('alert')).toHaveTextContent('云端工作查看设备情况')
      expect(screen.getByRole('alert')).not.toHaveTextContent('private transport details')
      expect(devices).toHaveAccessibleName('查看设备情况')
      await userEvent.click(devices)
      expect(window.location.pathname).toBe('/cloud-work')
      expect(f.binding).toHaveBeenCalledOnce()
      expect(f.lifecycle).not.toHaveBeenCalled()
    } finally {
      window.history.replaceState({}, '', location)
    }
  }
)

it('preserves compatibility errors from project loading until a successful reload', async () => {
  const f = fixture()
  projectList.mockRejectedValueOnce({ code: 'protocol_mismatch', message: 'private error' })
  render(f.workspace())
  expect(await screen.findByTestId('stand-in-view-devices')).toBeVisible()
  expect(screen.getByRole('alert')).not.toHaveTextContent('private error')
  await userEvent.click(screen.getByTestId('stand-in-project-catalog-retry'))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(screen.queryByTestId('stand-in-view-devices')).not.toBeInTheDocument()
})

it('offers remote device management for an incompatible bound executor and clears recovery after reload', async () => {
  const f = fixture({ version: 0, status: 'unbound', target: null })
  f.personalGet.mockImplementation(async userId => ({
    userId,
    executionDeviceId: 'mac',
    version: 0,
    roles: [],
  }))
  f.lifecycle.mockRejectedValueOnce(
    Object.assign(new Error('unsupported RPC'), { code: 'unsupported_method' })
  )
  const location = window.location.href
  try {
    render(f.workspace())
    const devices = await screen.findByTestId('stand-in-view-devices')
    expect(window.location.href).toBe(location)
    await userEvent.click(devices)
    expect(window.location.pathname).toBe('/cloud-work')
    expect(f.lifecycle).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByTestId('stand-in-project-catalog-retry'))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.queryByTestId('stand-in-view-devices')).not.toBeInTheDocument()
  } finally {
    window.history.replaceState({}, '', location)
  }
})

it.each([7, 8])(
  'reads the winning initial binding for owner %s without rebinding it',
  async owner => {
    const f = fixture({ version: 0, status: 'unbound', target: null })
    f.binding
      .mockResolvedValueOnce({ version: 0, status: 'unbound', target: null })
      .mockRejectedValueOnce(Object.assign(new Error('task changed'), { code: 'version_conflict' }))
      .mockResolvedValueOnce({
        version: 1,
        status: 'active',
        target: { userId: owner, deviceId: 'mac' },
      })
    render(f.workspace())
    if (owner === 7) {
      expect(await screen.findByTestId('retained-role-draft')).toHaveAttribute('data-owner', '7')
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    } else {
      expect(await screen.findByRole('alert')).toHaveTextContent('另一个账号')
      expect(screen.queryByTestId('retained-role-draft')).not.toBeInTheDocument()
    }
    expect(f.binding.mock.calls.map(call => call[1] ?? 'get')).toEqual(['get', 'bind', 'get'])
    expect(f.lifecycle).not.toHaveBeenCalled()
  }
)

it('initializes one durable binding without restoring the obsolete device preference', async () => {
  const f = fixture({ version: 0, status: 'unbound', target: null })
  localStorage.setItem('wework.stand-in.cloud-device:["",7]', 'cloud-one')
  render(f.workspace())
  expect(await screen.findByTestId('retained-role-draft')).toHaveAttribute('data-device', 'mac')
  expect(f.binding).toHaveBeenCalledWith('mac', 'bind', 0, {
    userId: 7,
    deviceId: 'mac',
    backendUrl: '',
  })
  expect(f.lifecycle).toHaveBeenCalledWith(7, 'mac', 'start')
})
