// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { render, waitFor } from '@testing-library/react'

import DeviceParamSync from '@/features/tasks/components/params/DeviceParamSync'

const mockReplace = jest.fn()
const mockSetSelectedDeviceId = jest.fn()
let mockSelectedDeviceId: string | null = 'stale-device'
let mockSearchParams = new URLSearchParams('taskId=42&deviceId=stale-device')
let mockSelectedTaskDetail = {
  id: 42,
  task_type: 'code',
}

jest.mock('next/navigation', () => ({
  usePathname: () => '/chat',
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@/contexts/DeviceContext', () => ({
  useDevices: () => ({
    devices: [{ device_id: 'stale-device' }],
    selectedDeviceId: mockSelectedDeviceId,
    setSelectedDeviceId: mockSetSelectedDeviceId,
  }),
}))

jest.mock('@/features/tasks/session/TaskSession', () => ({
  useTaskSession: () => ({ selectedTaskDetail: mockSelectedTaskDetail }),
}))

describe('DeviceParamSync', () => {
  beforeEach(() => {
    mockReplace.mockReset()
    mockSetSelectedDeviceId.mockReset()
    mockSelectedDeviceId = 'stale-device'
    mockSearchParams = new URLSearchParams('taskId=42&deviceId=stale-device')
    mockSelectedTaskDetail = { id: 42, task_type: 'code' }
  })

  it('removes a stale device parameter from an existing code task', async () => {
    render(<DeviceParamSync />)

    await waitFor(() => expect(mockSetSelectedDeviceId).toHaveBeenCalledWith(null))
    expect(mockReplace).toHaveBeenCalledWith('/chat?taskId=42')
  })
})
