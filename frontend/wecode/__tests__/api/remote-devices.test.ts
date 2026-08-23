// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'
import { createDockerRemoteDeviceCommand } from '@wecode/api/remote-devices'

jest.mock('@/apis/client', () => ({
  apiClient: {
    post: jest.fn(),
  },
}))

const mockedApiClient = apiClient as jest.Mocked<typeof apiClient>

describe('internal remote Docker device APIs', () => {
  it('generates a command with the compatible optional request fields', async () => {
    mockedApiClient.post.mockResolvedValue({ device_id: 'remote-device-1' })

    await createDockerRemoteDeviceCommand({
      client_origin: 'https://app.example.com',
      container_name: 'remote-device',
    })

    expect(mockedApiClient.post).toHaveBeenCalledWith('/remote-devices/docker/start-command', {
      client_origin: 'https://app.example.com',
      container_name: 'remote-device',
    })
  })
})
