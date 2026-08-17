// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { downloadSkill, listSkillMarketProviders, searchSkills } from '@/apis/skillMarketplace'
import { getToken } from '@/apis/user'
import { getApiBaseUrl } from '@/lib/runtime-config'

jest.mock('@/apis/user', () => ({
  getToken: jest.fn(),
}))

jest.mock('@/lib/runtime-config', () => ({
  getApiBaseUrl: jest.fn(),
}))

const mockedGetToken = getToken as jest.MockedFunction<typeof getToken>
const mockedGetApiBaseUrl = getApiBaseUrl as jest.MockedFunction<typeof getApiBaseUrl>
const mockedFetch = jest.fn()

describe('skillMarketplace API', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedGetToken.mockReturnValue('token')
    mockedGetApiBaseUrl.mockReturnValue('http://api.example.com')
    global.fetch = mockedFetch
  })

  it('lists all provider descriptors', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        providers: [
          {
            key: 'community',
            name: 'Community Hub',
            market_url: 'https://skills.example.com',
          },
          { key: 'partner', name: 'Partner Skills', market_url: null },
        ],
      }),
    })

    await expect(listSkillMarketProviders()).resolves.toEqual([
      {
        key: 'community',
        name: 'Community Hub',
        marketUrl: 'https://skills.example.com',
      },
      { key: 'partner', name: 'Partner Skills', marketUrl: undefined },
    ])
    expect(mockedFetch).toHaveBeenCalledWith('http://api.example.com/skill-market/providers', {
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer token',
      },
    })
  })

  it('propagates provider discovery failures', async () => {
    mockedFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
      })
      .mockRejectedValueOnce(new Error('network unavailable'))

    await expect(listSkillMarketProviders()).rejects.toThrow(
      'HTTP 503: Failed to load skill market providers'
    )
    await expect(listSkillMarketProviders()).rejects.toThrow('network unavailable')
  })

  it('normalizes nullable provider tags before returning skills', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 1,
        page: 1,
        pageSize: 20,
        skills: [
          {
            skillKey: 'partner/summary',
            name: 'Summary',
            tags: null,
          },
        ],
      }),
    })

    await expect(
      searchSkills('partner', {
        page: 1,
        pageSize: 20,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        skills: [expect.objectContaining({ tags: [] })],
      })
    )
  })

  it('routes search and download requests by provider key', async () => {
    const skillBlob = new Blob(['skill'])
    mockedFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          total: 0,
          page: 2,
          pageSize: 10,
          skills: [],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        blob: async () => skillBlob,
      })

    await searchSkills('partner', {
      keyword: 'docs',
      page: 2,
      pageSize: 10,
    })
    await expect(downloadSkill('partner', 'owner/skill')).resolves.toBe(skillBlob)

    expect(mockedFetch.mock.calls[0][0]).toBe(
      'http://api.example.com/skill-market/search?provider=partner&keyword=docs&page=2&pageSize=10'
    )
    expect(mockedFetch.mock.calls[1][0]).toBe(
      'http://api.example.com/skill-market/download/owner%2Fskill?provider=partner'
    )
  })
})
