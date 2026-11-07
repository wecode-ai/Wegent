import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
    userId,
    initialDeviceId,
    initialProfileId,
    headerActions,
    onSelectLocation,
    ref,
  }: {
    userId: number
    initialDeviceId: string
    initialProfileId?: string
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
          defaultValue={initialProfileId}
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
  }
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
    contentRoute: '/stand-in',
    onClose: vi.fn(),
    onOpenTask: vi.fn(),
  }
  const workspace = (changes: Partial<typeof props> = {}) => (
    <CloudConnectionContext.Provider value={{ isConnected: true } as CloudConnectionContextValue}>
      <PersonalStandInWorkspace {...props} {...changes} />
    </CloudConnectionContext.Provider>
  )
  return { props, workspace, binding, lifecycle, identity, personalGet }
}

async function confirmStop() {
  await userEvent.click(await screen.findByTestId('stand-in-instance-stop'))
  await userEvent.click(screen.getByTestId('stand-in-instance-stop-confirm'))
}

it('has no profile selector and cannot change the bound device via legacy navigation', async () => {
  const f = fixture()
  const view = render(f.workspace())
  const field = await screen.findByTestId('retained-role-draft')
  expect(screen.queryByTestId('stand-in-workspace-location')).not.toBeInTheDocument()
  expect(screen.getByTestId('stand-in-instance-stop').closest('header')).not.toBeNull()
  await userEvent.click(screen.getByTestId('legacy-change-device'))
  expect(field).toHaveAttribute('data-device', 'mac')
  expect(f.binding).toHaveBeenCalledTimes(1)
  view.rerender(f.workspace({ contentRoute: '/stand-in?deviceId=cloud-one&profileId=other' }))
  expect(screen.getByTestId('retained-role-draft')).toBe(field)
  expect(field).toHaveValue('')
  expect(field).toHaveAttribute('data-device', 'mac')
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
  expect(screen.queryByTestId('retained-role-draft')).not.toBeInTheDocument()
  await userEvent.click(screen.getByTestId('stand-in-project-catalog-retry'))
  expect(await screen.findByTestId('retained-role-draft')).toHaveAttribute('data-device', 'mac')
})

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
