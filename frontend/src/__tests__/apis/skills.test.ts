// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

jest.mock('@/apis/user', () => ({
  getToken: jest.fn(() => 'test-token'),
}))

jest.mock('@/lib/runtime-config', () => ({
  getApiBaseUrl: jest.fn(() => 'http://localhost:8000/api'),
}))

import { fetchSkillReferences, updateMyDefaultSkillBindingExceptions } from '@/apis/skills'

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

describe('updateMyDefaultSkillBindingExceptions', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    jest.clearAllMocks()
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  it('patches automatic Skill exceptions', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 10,
        target_type: 'user',
        target_id: 'user:1',
        skill_ref: {
          skill_id: 7,
          name: 'translate-zh-en',
          namespace: 'default',
          is_public: false,
        },
        exceptions: [{ type: 'mode', value: 'code' }],
      }),
    })
    global.fetch = fetchMock as typeof fetch

    const result = await updateMyDefaultSkillBindingExceptions(7, [{ type: 'mode', value: 'code' }])

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/api/v1/kinds/skills/7/bindings/me',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ exceptions: [{ type: 'mode', value: 'code' }] }),
      }
    )
    expect(result.exceptions).toEqual([{ type: 'mode', value: 'code' }])
  })

  it('patches automatic Skill force preload setting when provided', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 10,
        target_type: 'user',
        target_id: 'user:1',
        skill_ref: {
          skill_id: 7,
          name: 'translate-zh-en',
          namespace: 'default',
          is_public: false,
        },
        exceptions: [],
        force_preload: true,
      }),
    })
    global.fetch = fetchMock as typeof fetch

    const result = await updateMyDefaultSkillBindingExceptions(7, [], true)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/api/v1/kinds/skills/7/bindings/me',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ exceptions: [], force_preload: true }),
      }
    )
    expect(result.force_preload).toBe(true)
  })
})
