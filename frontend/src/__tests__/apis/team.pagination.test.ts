jest.mock('@/apis/client', () => ({ apiClient: { get: jest.fn() } }))
jest.mock('@/apis/user', () => ({ getToken: jest.fn() }))

import { apiClient } from '@/apis/client'
import { teamApis } from '@/apis/team'
import { fetchManagedTeamsPage, fetchTeamsList } from '@/features/settings/services/teams'
import { resourceLibraryApi } from '@/apis/resourceLibrary'
import type { Team } from '@/types/api'
import { getToken } from '@/apis/user'

const get = jest.mocked(apiClient.get)

function makeTeam(id: number): Team {
  return {
    id,
    name: `team-${id}`,
    description: '',
    bots: [],
    workflow: {},
    is_active: true,
    user_id: 1,
    created_at: '2026-09-01T00:00:00',
    updated_at: '2026-09-01T00:00:00',
  }
}

describe('team catalog pagination', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    get.mockReset()
    jest.mocked(getToken).mockReturnValue('session-a')
  })

  it('returns a single managed page without following the next cursor', async () => {
    const response = {
      resource_type: 'agent' as const,
      items: [makeTeam(1)],
      next_cursor: 'next',
      has_more: true,
      limit: 100,
    }
    const search = jest.spyOn(resourceLibraryApi, 'searchResources').mockResolvedValue(response)
    const controller = new AbortController()
    await expect(
      fetchManagedTeamsPage(
        { scope: 'all', keyword: '开发', sourceFilter: 'mine' },
        controller.signal
      )
    ).resolves.toEqual({ items: response.items, next: { cursor: 'next' } })
    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith(
      { scope: 'all', keyword: '开发', sourceFilter: 'mine', resourceType: 'agent', limit: 100 },
      controller.signal
    )
    expect(get).not.toHaveBeenCalled()
  })

  it('browses /teams by page number without calling search, preserving filters and cancellation', async () => {
    const all = Array.from({ length: 205 }, (_, id) => makeTeam(id))
    get.mockImplementation(async endpoint => {
      const page = Number(
        new URL(String(endpoint), 'https://test.invalid').searchParams.get('page')
      )
      return { total: all.length, items: all.slice((page - 1) * 100, page * 100) }
    })
    const search = jest.spyOn(resourceLibraryApi, 'searchResources')
    const signal = new AbortController().signal
    const params = {
      keyword: '  ',
      scope: 'group' as const,
      groupNames: ['first', 'second'],
      sourceFilter: 'mine' as const,
      mode: 'chat' as const,
    }
    const first = await fetchManagedTeamsPage(params, signal)
    expect(first).toEqual({ items: all.slice(0, 100), next: { page: 2 } })
    expect(get).toHaveBeenCalledTimes(1)
    const second = await fetchManagedTeamsPage({ ...params, ...first.next }, signal)
    const last = await fetchManagedTeamsPage({ ...params, ...second.next }, signal)
    expect(second.items).toHaveLength(100)
    expect(last).toEqual({ items: all.slice(200), next: null })
    expect(search).not.toHaveBeenCalled()
    expect(
      get.mock.calls.map(([endpoint]) =>
        new URL(endpoint, 'https://test.invalid').searchParams.get('page')
      )
    ).toEqual(['1', '2', '3'])
    for (const [endpoint, options] of get.mock.calls) {
      const url = new URL(endpoint, 'https://test.invalid')
      expect(url.pathname).toBe('/teams')
      expect(url.searchParams.getAll('group_names')).toEqual(['first', 'second'])
      expect(url.searchParams.get('source_filter')).toBe('mine')
      expect(url.searchParams.get('mode')).toBe('chat')
      expect(url.searchParams.has('keyword')).toBe(false)
      expect(url.searchParams.has('cursor')).toBe(false)
      expect(options?.signal).toBe(signal)
    }
  })

  it.each([
    ['all', undefined],
    ['personal', undefined],
    ['group', 'test group'],
  ] as const)('loads all 205 teams for %s management lists', async (scope, groupName) => {
    const items = Array.from({ length: 205 }, (_, id) => ({ id, name: `team-${id}` }))
    get.mockImplementation(async endpoint => {
      const query = new URL(String(endpoint), 'https://test.invalid').searchParams
      expect(query.get('scope')).toBe(scope)
      expect(query.get('group_name')).toBe(groupName ?? null)
      expect(query.get('limit')).toBe('100')
      const offset = (Number(query.get('page')) - 1) * 100
      return { total: items.length, items: items.slice(offset, offset + 100) }
    })

    await expect(fetchTeamsList(scope, groupName)).resolves.toEqual(items)
    expect(get).toHaveBeenCalledTimes(3)
  })

  it('preserves explicit single-page requests', async () => {
    get.mockResolvedValue({ total: 205, items: [{ id: 101 }] })

    await expect(teamApis.getTeams({ page: 2, limit: 100 }, 'all')).resolves.toEqual({
      total: 205,
      items: [{ id: 101 }],
    })
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('/teams?page=2&limit=100&scope=all', { signal: undefined })
  })

  it('shares all pages between concurrent catalog consumers', async () => {
    const items = Array.from({ length: 205 }, (_, id) => makeTeam(id))
    get.mockImplementation(async endpoint => {
      const query = new URL(String(endpoint), 'https://test.invalid').searchParams
      const offset = (Number(query.get('page')) - 1) * 100
      return { total: items.length, items: items.slice(offset, offset + 100) }
    })

    const [context, catalog, list] = await Promise.all([
      teamApis.getAllTeams('all'),
      teamApis.getAllTeams('all'),
      fetchTeamsList('all'),
    ])
    expect(context.items).toEqual(items)
    expect(catalog).toEqual({ items, total: items.length })
    expect(list).toEqual(items)
    expect(
      get.mock.calls.map(([url]) =>
        new URL(String(url), 'https://test.invalid').searchParams.get('page')
      )
    ).toEqual(['1', '2', '3'])
  })

  it('shares the catalog with a consumer that joins after page one', async () => {
    const items = Array.from({ length: 205 }, (_, id) => makeTeam(id))
    let releaseSecondPage!: () => void
    const secondPagePending = new Promise<void>(resolve => {
      releaseSecondPage = resolve
    })
    let reachedSecondPage!: () => void
    const secondPageStarted = new Promise<void>(resolve => {
      reachedSecondPage = resolve
    })
    get.mockImplementation(async endpoint => {
      const page = Number(
        new URL(String(endpoint), 'https://test.invalid').searchParams.get('page')
      )
      if (page === 2) {
        reachedSecondPage()
        await secondPagePending
      }
      return { total: items.length, items: items.slice((page - 1) * 100, page * 100) }
    })

    const initial = teamApis.getAllTeams('all')
    await secondPageStarted
    const later = teamApis.getAllTeams('all')
    releaseSecondPage()
    const results = await Promise.all([initial, later])
    results.forEach(result => expect(result.items).toEqual(items))
    expect(get).toHaveBeenCalledTimes(3)
  })

  it('does not share requests across accounts or resource scopes', async () => {
    get.mockResolvedValue({ total: 0, items: [] })
    const requests = [
      teamApis.getAllTeams('all'),
      teamApis.getAllTeams('personal'),
      teamApis.getAllTeams('group', 'first'),
      teamApis.getAllTeams('group', 'second'),
    ]
    jest.mocked(getToken).mockReturnValue('session-b')
    requests.push(teamApis.getAllTeams('all'))
    await Promise.all(requests)
    expect(get).toHaveBeenCalledTimes(5)
  })

  it('releases a failed shared request so a new load can succeed', async () => {
    const error = new Error('Page unavailable')
    get.mockRejectedValueOnce(error)
    const results = await Promise.allSettled([
      teamApis.getAllTeams('all'),
      teamApis.getAllTeams('all'),
    ])
    expect(results).toEqual([
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error },
    ])
    expect(get).toHaveBeenCalledTimes(1)

    get.mockResolvedValue({ total: 1, items: [makeTeam(1)] })
    await expect(teamApis.getAllTeams('all')).resolves.toEqual({ total: 1, items: [makeTeam(1)] })
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('refreshes after a mutation without an older request clearing the new one', async () => {
    type Page = { total: number; items: Team[] }
    let resolveOld!: (page: Page) => void
    let resolveFresh!: (page: Page) => void
    get
      .mockImplementationOnce(
        () =>
          new Promise<Page>(resolve => {
            resolveOld = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<Page>(resolve => {
            resolveFresh = resolve
          })
      )
    const oldRequest = teamApis.getAllTeams('all')
    const refresh = teamApis.getAllTeams('all', undefined, true)
    resolveOld({ total: 0, items: [] })
    await oldRequest

    const joined = teamApis.getAllTeams('all')
    expect(get).toHaveBeenCalledTimes(2)
    const updated = { total: 1, items: [makeTeam(1)] }
    resolveFresh(updated)
    expect(await refresh).toEqual(updated)
    expect(await joined).toEqual(updated)

    get.mockResolvedValue({ total: 0, items: [] })
    await expect(teamApis.getAllTeams('all')).resolves.toEqual({ total: 0, items: [] })
    expect(get).toHaveBeenCalledTimes(3)
  })

  it('shares the default all scope without mixing it with personal scope', async () => {
    get.mockResolvedValue({ total: 0, items: [] })
    await Promise.all([
      teamApis.getAllTeams(),
      teamApis.getAllTeams('all'),
      teamApis.getAllTeams('personal'),
    ])
    expect(get).toHaveBeenCalledTimes(2)
  })
})
