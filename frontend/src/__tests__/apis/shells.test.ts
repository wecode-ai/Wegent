// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'
import { shellApis } from '@/apis/shells'

jest.mock('@/apis/client', () => ({
  apiClient: {
    get: jest.fn(),
  },
}))

const mockedApiClient = apiClient as jest.Mocked<typeof apiClient>

describe('shellApis', () => {
  beforeEach(() => {
    mockedApiClient.get.mockReset()
  })

  it('excludes Agno from local engine shell choices', async () => {
    mockedApiClient.get.mockResolvedValue({
      data: [
        {
          name: 'ClaudeCode',
          type: 'public',
          displayName: 'Claude Code',
          shellType: 'ClaudeCode',
          executionType: 'local_engine',
        },
        {
          name: 'Agno',
          type: 'public',
          displayName: 'Agno',
          shellType: 'Agno',
          executionType: 'local_engine',
        },
        {
          name: 'Chat',
          type: 'public',
          displayName: 'Chat',
          shellType: 'Chat',
          executionType: null,
        },
        {
          name: 'custom-code',
          type: 'user',
          displayName: 'Custom Code',
          shellType: 'ClaudeCode',
          executionType: 'local_engine',
        },
      ],
    })

    await expect(shellApis.getLocalEngineShells()).resolves.toEqual([
      {
        name: 'ClaudeCode',
        type: 'public',
        displayName: 'Claude Code',
        shellType: 'ClaudeCode',
        executionType: 'local_engine',
      },
    ])
  })
})
