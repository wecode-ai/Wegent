// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

jest.mock('@/apis/user', () => ({
  getToken: jest.fn(() => 'test-token'),
}))

jest.mock('@/lib/runtime-config', () => ({
  getApiBaseUrl: jest.fn(() => 'http://localhost:8000/api'),
}))

import { fetchSkillReferences } from '@/apis/skills'

describe('fetchSkillReferences', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    jest.clearAllMocks()
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  it('fetches skill references successfully', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        skill_id: 1,
        skill_name: 'android-source-setup',
        referenced_ghosts: [{ id: 2, name: 'builder-ghost', namespace: 'mobile-team' }],
      }),
    })
    global.fetch = fetchMock as typeof fetch

    const result = await fetchSkillReferences(1)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/api/v1/kinds/skills/1/references',
      {
        headers: { Authorization: 'Bearer test-token' },
      }
    )
    expect(result.referenced_ghosts).toHaveLength(1)
    expect(result.referenced_ghosts[0].name).toBe('builder-ghost')
  })

  it('throws parsed error message when request fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      text: async () => JSON.stringify({ detail: 'Failed to fetch skill references' }),
    }) as typeof fetch

    await expect(fetchSkillReferences(9)).rejects.toThrow('Failed to fetch skill references')
  })
})
