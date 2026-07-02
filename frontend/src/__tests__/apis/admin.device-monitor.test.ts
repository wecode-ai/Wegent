// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { adminApis, restartAllCloudDevices, upgradeAllLocalDevices } from '@/apis/admin'
import { apiClient } from '@/apis/client'

jest.mock('@/apis/client', () => ({
  apiClient: {
    post: jest.fn(),
  },
}))

const mockedApiClient = apiClient as jest.Mocked<typeof apiClient>

describe('admin device monitor APIs', () => {
  beforeEach(() => {
    mockedApiClient.post.mockReset()
  })

  it('exports the bulk local upgrade API on the named function and adminApis object', async () => {
    mockedApiClient.post.mockResolvedValue({
      success: true,
      batch_id: 'local-batch-1',
      action: 'local_upgrade',
      status: 'pending',
      total: 1,
      completed: 0,
      failed: 0,
      message: 'queued',
    })

    await expect(upgradeAllLocalDevices()).resolves.toEqual(
      expect.objectContaining({ batch_id: 'local-batch-1' })
    )

    expect(typeof adminApis.upgradeAllLocalDevices).toBe('function')
    expect(adminApis.upgradeAllLocalDevices).toBe(upgradeAllLocalDevices)
    expect(mockedApiClient.post).toHaveBeenCalledWith(
      '/admin/device-monitor/devices/local/upgrade-all',
      {
        force_stop_tasks: false,
      }
    )
  })

  it('exports the bulk cloud restart API on the named function and adminApis object', async () => {
    mockedApiClient.post.mockResolvedValue({
      success: true,
      batch_id: 'cloud-batch-1',
      action: 'cloud_restart',
      status: 'pending',
      total: 1,
      completed: 0,
      failed: 0,
      message: 'queued',
    })

    await expect(restartAllCloudDevices()).resolves.toEqual(
      expect.objectContaining({ batch_id: 'cloud-batch-1' })
    )

    expect(typeof adminApis.restartAllCloudDevices).toBe('function')
    expect(adminApis.restartAllCloudDevices).toBe(restartAllCloudDevices)
    expect(mockedApiClient.post).toHaveBeenCalledWith(
      '/admin/device-monitor/devices/cloud/restart-all'
    )
  })
})
