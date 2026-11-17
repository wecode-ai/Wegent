// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { apiClient } from '@/apis/client'
import type { DeviceInfo } from '@/apis/devices'
import { useDeviceIde } from '@/features/devices/hooks/useDeviceIde'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
jest.mock('sonner', () => ({ toast: { error: jest.fn() } }))

const device: DeviceInfo = {
  id: 1,
  device_id: 'remote/device',
  name: 'Remote Executor',
  status: 'busy',
  is_default: false,
  device_type: 'remote',
  connection_mode: 'websocket',
  slot_used: 1,
  slot_max: 1,
  running_tasks: [],
  executor_version: null,
  latest_version: null,
  update_available: false,
}

function createTab() {
  return { closed: false, opener: window, location: { replace: jest.fn() }, close: jest.fn() }
}

describe('useDeviceIde', () => {
  const openWindow = () => jest.spyOn(window, 'open')
  const startSession = () => jest.spyOn(apiClient, 'post')

  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('reserves one tab before starting the session and keeps the clicked device when selection changes', async () => {
    const tab = createTab()
    const open = openWindow().mockReturnValue(tab as unknown as Window)
    let finishSession!: (result: { url: string }) => void
    const start = startSession().mockImplementation(() => {
      expect(open).toHaveBeenCalledWith('about:blank', '_blank')
      expect(tab.opener).toBeNull()
      return new Promise(resolve => {
        finishSession = resolve as typeof finishSession
      })
    })
    const { result, rerender } = renderHook(({ target }) => useDeviceIde(target), {
      initialProps: { target: device },
    })

    act(() => {
      void result.current?.open()
      void result.current?.open()
    })
    expect(result.current?.opening).toBe(true)
    expect(open).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledWith('/devices/remote%2Fdevice/code-server')

    rerender({ target: { ...device, device_id: 'other-device' } })
    expect(result.current?.opening).toBe(false)
    const url = 'https://ide.example.test/s/code-1/?token=test'
    await act(async () => finishSession({ url }))

    expect(tab.location.replace).toHaveBeenCalledWith(url)
    expect(tab.close).not.toHaveBeenCalled()
  })

  it('explains when the browser blocks the tab and does not start a session', async () => {
    openWindow().mockReturnValue(null)
    const start = startSession()
    const { result } = renderHook(() => useDeviceIde(device))

    await act(async () => result.current?.open())

    expect(start).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('ide.popup_blocked')
  })

  it.each(['', 'javascript:void(0)', '/relative'])(
    'closes the tab for an invalid session URL %j',
    async url => {
      const tab = createTab()
      openWindow().mockReturnValue(tab as unknown as Window)
      startSession().mockResolvedValue({ url })
      const { result } = renderHook(() => useDeviceIde(device))

      await act(async () => result.current?.open())

      expect(tab.location.replace).not.toHaveBeenCalled()
      expect(tab.close).toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledWith('ide.invalid_url')
      expect(result.current?.opening).toBe(false)
    }
  )

  it('closes the failed tab and lets the user retry', async () => {
    const failedTab = createTab()
    const retryTab = createTab()
    openWindow()
      .mockReturnValueOnce(failedTab as unknown as Window)
      .mockReturnValueOnce(retryTab as unknown as Window)
    const url = 'http://ide.example.test/s/code-2/'
    startSession()
      .mockRejectedValueOnce(new Error('device went offline'))
      .mockResolvedValue({ url })
    const { result } = renderHook(() => useDeviceIde(device))

    await act(async () => result.current?.open())
    expect(failedTab.close).toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('ide.start_failed')

    await act(async () => result.current?.open())
    expect(retryTab.location.replace).toHaveBeenCalledWith(url)
  })

  it('shows the disabled capability without starting a session', async () => {
    const open = openWindow()
    const { result } = renderHook(() =>
      useDeviceIde({
        ...device,
        runtime_features: { schemaVersion: 1, interactiveSessions: { codeServer: false } },
      })
    )

    expect(result.current?.disabledReason).toBe('ide.disabled_on_device')
    await act(async () => result.current?.open())
    expect(open).not.toHaveBeenCalled()
  })
})
