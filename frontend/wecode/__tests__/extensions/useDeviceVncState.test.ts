// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from '@testing-library/react'

import { cloudDeviceApis } from '@wecode/apis'
import { useDeviceVncState } from '@wecode/hooks'

jest.mock('@wecode/apis', () => ({
  cloudDeviceApis: {
    getCloudDeviceStatus: jest.fn(),
  },
}))

describe('useDeviceVncState', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('auto opens VNC for an online cloud device after sandbox info loads', async () => {
    ;(cloudDeviceApis.getCloudDeviceStatus as jest.Mock).mockResolvedValue({
      sandbox_id: 'sandbox-1',
    })

    const { result } = renderHook(() =>
      useDeviceVncState({
        selectedDevice: {
          device_id: 'device-1',
          device_type: 'cloud',
          status: 'online',
        },
        selectedDeviceId: 'device-1',
      })
    )

    await waitFor(() => {
      expect(cloudDeviceApis.getCloudDeviceStatus).toHaveBeenCalledWith('device-1')
    })

    await waitFor(() => {
      expect(result.current.sandboxId).toBe('sandbox-1')
      expect(result.current.isVncOpen).toBe(true)
    })
  })

  test('does not reopen VNC after the user closes it for the same device', async () => {
    ;(cloudDeviceApis.getCloudDeviceStatus as jest.Mock)
      .mockResolvedValueOnce({
        sandbox_id: 'sandbox-1',
      })
      .mockResolvedValueOnce({
        sandbox_id: 'sandbox-1',
      })

    const { result, rerender } = renderHook(
      ({ status }: { status: string }) =>
        useDeviceVncState({
          selectedDevice: {
            device_id: 'device-1',
            device_type: 'cloud',
            status,
          },
          selectedDeviceId: 'device-1',
        }),
      {
        initialProps: {
          status: 'online',
        },
      }
    )

    await waitFor(() => {
      expect(result.current.isVncOpen).toBe(true)
    })

    act(() => {
      result.current.setIsVncOpen(false)
    })

    expect(result.current.isVncOpen).toBe(false)

    rerender({
      status: 'busy',
    })

    await waitFor(() => {
      expect(cloudDeviceApis.getCloudDeviceStatus).toHaveBeenCalledTimes(2)
    })

    expect(result.current.isVncOpen).toBe(false)
  })
})
