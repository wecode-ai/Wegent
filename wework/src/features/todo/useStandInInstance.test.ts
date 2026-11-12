import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInInstanceBinding } from '@/api/standIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import '@/i18n'
import { useStandInInstance } from './useStandInInstance'

describe('useStandInInstance read ordering', () => {
  it.each(['resolve', 'reject'] as const)(
    'keeps a successful rebind after the previous stopped profile read %ss',
    async outcome => {
      const previous = { userId: 1, deviceId: 'previous', backendUrl: 'https://backend.test' }
      const target = { ...previous, deviceId: 'next' }
      const stopped: StandInInstanceBinding = { version: 2, status: 'stopped', target: previous }
      const active: StandInInstanceBinding = { version: 3, status: 'active', target }
      let resolve!: (value: PersonalStandInSettings) => void
      let reject!: (error: Error) => void
      const profile = new Promise<PersonalStandInSettings>((accept, fail) => {
        resolve = accept
        reject = fail
      })
      const personalGet = vi.fn(() => profile)
      const binding = vi.fn(async (_device: string, operation?: string) =>
        operation === 'bind' ? active : stopped
      )
      const lifecycle = vi.fn(async () => ({ userId: 1, executionDeviceId: 'next', roles: [] }))
      const services = {
        standInApi: { binding, personalGet, lifecycle },
        getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'local' }),
      } as unknown as WorkbenchServices
      const devices: Parameters<typeof useStandInInstance>[2] = []
      const { result } = renderHook(() =>
        useStandInInstance(services, 1, devices, true, true, previous.backendUrl)
      )
      await waitFor(() => expect(personalGet).toHaveBeenCalledOnce())
      expect(result.current.binding).toEqual(stopped)

      await act(async () => {
        await result.current.bind(target)
      })
      expect(result.current.binding).toEqual(active)
      expect(lifecycle).toHaveBeenCalledWith(1, 'next', 'start')

      await act(async () => {
        if (outcome === 'reject') reject(new Error('Previous device is offline'))
        else resolve({ userId: 1, executionDeviceId: 'previous', version: 1, roles: [] })
      })
      expect(result.current.binding).toEqual(active)
      expect(result.current.error).toBeNull()
      expect(binding).toHaveBeenCalledTimes(2)
    }
  )
})
