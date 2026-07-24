// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, waitFor } from '@testing-library/react'

import DeviceTaskSync from '@/features/tasks/components/params/DeviceTaskSync'

let mockSelectedTaskDetail: {
  id: number
  task_type: 'code' | 'task'
  device_id?: string
}
let mockSelectedDeviceId: string | null
const mockSetSelectedDeviceId = jest.fn()

jest.mock('@/features/tasks/session/TaskSession', () => ({
  useTaskSession: () => ({ selectedTaskDetail: mockSelectedTaskDetail }),
}))

jest.mock('@/contexts/DeviceContext', () => ({
  useDevices: () => ({
    devices: [{ device_id: 'saved-device' }, { device_id: 'stale-device' }],
    selectedDeviceId: mockSelectedDeviceId,
    setSelectedDeviceId: mockSetSelectedDeviceId,
  }),
}))

describe('DeviceTaskSync', () => {
  beforeEach(() => {
    mockSetSelectedDeviceId.mockReset()
    mockSelectedDeviceId = null
    mockSelectedTaskDetail = {
      id: 42,
      task_type: 'task',
      device_id: 'saved-device',
    }
  })

  it('clears stale device state for a code task with a polluted device id', async () => {
    mockSelectedDeviceId = 'stale-device'
    mockSelectedTaskDetail = {
      id: 42,
      task_type: 'code',
      device_id: 'saved-device',
    }

    render(<DeviceTaskSync />)

    await waitFor(() => expect(mockSetSelectedDeviceId).toHaveBeenCalledWith(null))
    expect(mockSetSelectedDeviceId).not.toHaveBeenCalledWith('saved-device')
  })

  it('selects the saved device for a device-mode task', async () => {
    render(<DeviceTaskSync />)

    await waitFor(() => expect(mockSetSelectedDeviceId).toHaveBeenCalledWith('saved-device'))
  })
})
