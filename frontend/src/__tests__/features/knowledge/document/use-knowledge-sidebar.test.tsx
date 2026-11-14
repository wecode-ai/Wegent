// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from '@testing-library/react'

import { useKnowledgeSidebar } from '@/features/knowledge/document/hooks/useKnowledgeSidebar'
import { getKnowledgeBase } from '@/apis/knowledge'
import type { AllGroupedKnowledgeResponse, KnowledgeBaseWithGroupInfo } from '@/types/knowledge'

const mockGetAllGrouped = jest.fn()
let mockUser = { id: 1 }
let mockScope = 'backend:session-1'
const mockT = (key: string) => key
jest.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: mockT }) }))
jest.mock('@/apis/client', () => ({
  __esModule: true,
  default: { getCacheScope: () => mockScope },
}))

jest.mock('@/apis/knowledge-base', () => ({
  knowledgeBaseApi: {
    getAllGrouped: () => mockGetAllGrouped(),
  },
}))

jest.mock('@/apis/knowledge', () => ({
  getKnowledgeBase: jest.fn(),
}))

jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: mockUser }),
}))

describe('useKnowledgeSidebar', () => {
  beforeEach(() => {
    mockUser = { id: 1 }
    mockScope = 'backend:session-1'
    localStorage.clear()
    mockGetAllGrouped.mockReset()
  })

  it('counts group knowledge bases by internal group id rather than display name', async () => {
    const response: AllGroupedKnowledgeResponse = {
      personal: { created_by_me: [], shared_with_me: [] },
      groups: [
        {
          group_name: 'engineering',
          group_display_name: 'Engineering Team',
          kb_count: 1,
          knowledge_bases: [
            {
              id: 1,
              name: 'Architecture',
              description: null,
              kb_type: 'notebook',
              namespace: 'engineering',
              document_count: 0,
              updated_at: '2026-09-22T00:00:00Z',
              created_at: '2026-09-22T00:00:00Z',
              user_id: 1,
              group_id: 'engineering',
              group_name: 'Engineering Team',
              group_type: 'group',
            },
          ],
        },
      ],
      organization: {
        namespace: 'organization',
        display_name: 'Organization',
        kb_count: 0,
        knowledge_bases: [],
      },
      summary: {
        total_count: 1,
        personal_count: 0,
        group_count: 1,
        organization_count: 0,
      },
    }
    mockGetAllGrouped.mockResolvedValue(response)

    const { result } = renderHook(() => useKnowledgeSidebar())

    await waitFor(() => expect(result.current.isGroupsLoading).toBe(false))

    expect(result.current.groups.find(group => group.id === 'group-engineering')?.kbCount).toBe(1)
  })
})

function row(
  id: number,
  overrides: Partial<KnowledgeBaseWithGroupInfo> = {}
): KnowledgeBaseWithGroupInfo {
  return {
    id,
    name: 'Library ' + id,
    description: null,
    kb_type: 'notebook',
    namespace: 'default',
    document_count: 0,
    updated_at: '2026-11-04T00:00:00Z',
    created_at: '2026-11-04T00:00:00Z',
    user_id: 2,
    group_id: 'default',
    group_name: 'Personal',
    group_type: 'personal-shared',
    my_role: 'Reporter',
    ...overrides,
  }
}
function dataset(): AllGroupedKnowledgeResponse {
  return {
    personal: { created_by_me: [row(1, { user_id: 1 })], shared_with_me: [row(2)] },
    groups: ['alpha', 'beta', 'gamma', 'origin'].map(name => ({
      group_name: name,
      group_display_name: name === 'origin' ? 'Real origin' : 'Same display name',
      kb_count: name === 'gamma' ? 0 : 1,
      knowledge_bases:
        name === 'gamma'
          ? []
          : [
              row(3, {
                user_id: 1,
                namespace: 'origin',
                group_type: 'group',
                group_id: name,
                my_role: 'Owner',
              }),
            ],
    })),
    organization: {
      namespace: 'company',
      display_name: 'Company',
      kb_count: 1,
      knowledge_bases: [
        row(4, {
          user_id: 1,
          namespace: 'company',
          group_type: 'organization',
          my_role: 'Owner',
        }),
      ],
    },
    summary: { total_count: 4, personal_count: 2, group_count: 1, organization_count: 1 },
  }
}
function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('relationship navigation and scoped requests', () => {
  beforeEach(() => {
    mockUser = { id: 1 }
    mockScope = 'backend:session-1'
    localStorage.clear()
    mockGetAllGrouped.mockReset()
  })
  it('deduplicates identity, retains every team, classifies across spaces and separates real space', async () => {
    mockGetAllGrouped.mockResolvedValue(dataset())
    const { result } = renderHook(() => useKnowledgeSidebar())
    await waitFor(() => expect(result.current.hasLoaded).toBe(true))
    expect(result.current.allKnowledgeBases.map(kb => kb.id)).toEqual([1, 2, 3, 4])
    expect(result.current.visibleKnowledgeBases.personalCreatedByMe.map(kb => kb.id)).toEqual([
      1, 3,
    ])
    expect(result.current.visibleKnowledgeBases.personalSharedWithMe.map(kb => kb.id)).toEqual([2])
    expect(result.current.allKnowledgeBasesWithGroupInfo.find(kb => kb.id === 3)?.team_ids).toEqual(
      ['alpha', 'beta', 'origin']
    )
    expect(result.current.getKbGroupInfo(result.current.allKnowledgeBases[2]).groupName).toBe(
      'Real origin'
    )
    act(() => result.current.setFilterGroupId('group-beta'))
    expect(result.current.summary?.total_count).toBe(4)
    act(() => result.current.selectGroup('shared'))
    expect(result.current.filterGroupId).toBeNull()
    expect(result.current.groups.find(group => group.id === 'group-gamma')?.kbCount).toBe(0)
  })
  it('applies the advanced switch consistently to identity and relationship counts', async () => {
    const data = dataset()
    data.personal.created_by_me[0].kb_type = 'code_wiki'
    mockGetAllGrouped.mockResolvedValue(data)
    const { result, rerender } = renderHook(
      ({ advanced }) => useKnowledgeSidebar({ showAdvancedKnowledge: advanced }),
      { initialProps: { advanced: false } }
    )
    await waitFor(() => expect(result.current.hasLoaded).toBe(true))
    expect(result.current.summary?.total_count).toBe(3)
    expect(result.current.visibleKnowledgeBases.personalCreatedByMe).toHaveLength(1)
    rerender({ advanced: true })
    expect(result.current.summary?.total_count).toBe(4)
    expect(result.current.visibleKnowledgeBases.personalCreatedByMe).toHaveLength(2)
  })
  it.each(['user', 'backend', 'session'])(
    'isolates %s changes and rejects late list and detail responses',
    async kind => {
      mockGetAllGrouped.mockResolvedValueOnce(dataset())
      const detail = pending<never>()
      jest.mocked(getKnowledgeBase).mockReturnValueOnce(detail.promise)
      const { result, rerender } = renderHook(() => useKnowledgeSidebar())
      await waitFor(() => expect(result.current.hasLoaded).toBe(true))
      act(() => result.current.selectKb(result.current.allKnowledgeBases[0]))
      const old = pending<AllGroupedKnowledgeResponse>()
      mockGetAllGrouped.mockReturnValueOnce(old.promise)
      let refresh!: Promise<void>
      act(() => {
        refresh = result.current.refreshAll()
      })
      const fresh = pending<AllGroupedKnowledgeResponse>()
      mockGetAllGrouped.mockReturnValueOnce(fresh.promise)
      if (kind === 'user') mockUser = { id: 9 }
      else mockScope = kind + ':new'
      rerender()
      expect(result.current.allKnowledgeBases).toEqual([])
      expect(result.current.selectedKb).toBeNull()
      expect(result.current.recentItems).toEqual([])
      await act(async () => {
        old.resolve(dataset())
        await refresh
        detail.resolve({ id: 1 } as never)
      })
      expect(result.current.allKnowledgeBases).toEqual([])
      expect(result.current.selectedKb).toBeNull()
      const next = dataset()
      next.personal = { created_by_me: [], shared_with_me: [] }
      next.groups = []
      next.organization.knowledge_bases = []
      await act(async () => fresh.resolve(next))
      expect(result.current.hasLoaded).toBe(true)
      expect(result.current.summary?.total_count).toBe(0)
    }
  )
  it('keeps valid same-scope data on refresh failure, exposes retry and clears revoked selection after success', async () => {
    mockGetAllGrouped.mockResolvedValueOnce(dataset())
    jest.mocked(getKnowledgeBase).mockResolvedValueOnce({ id: 1 } as never)
    const { result } = renderHook(() => useKnowledgeSidebar())
    await waitFor(() => expect(result.current.hasLoaded).toBe(true))
    await act(async () => result.current.selectKb(result.current.allKnowledgeBases[0]))
    mockGetAllGrouped.mockRejectedValueOnce(new Error('offline'))
    await act(async () => result.current.refreshAll())
    expect(result.current.loadError).toBe('offline')
    expect(result.current.allKnowledgeBases).toHaveLength(4)
    expect(result.current.selectedKb?.id).toBe(1)
    const next = dataset()
    next.personal.created_by_me = []
    mockGetAllGrouped.mockResolvedValueOnce(next)
    await act(async () => result.current.refreshAll())
    expect(result.current.loadError).toBeNull()
    expect(result.current.selectedKb).toBeNull()
  })
  it('distinguishes initial failure from a successful empty collection', async () => {
    mockGetAllGrouped.mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useKnowledgeSidebar())
    await waitFor(() => expect(result.current.loadError).toBe('offline'))
    expect(result.current.hasLoaded).toBe(false)
    const next = dataset()
    next.personal = { created_by_me: [], shared_with_me: [] }
    next.groups = []
    next.organization.knowledge_bases = []
    mockGetAllGrouped.mockResolvedValueOnce(next)
    await act(async () => result.current.refreshAll())
    expect(result.current.hasLoaded).toBe(true)
    expect(result.current.loadError).toBeNull()
    expect(result.current.summary?.total_count).toBe(0)
  })
})

it.each([
  'clearSelection',
  'selectGroups',
  'selectSourceView',
  'selectAll',
  'selectGroup',
] as const)('ignores a delayed detail after %s', async action => {
  mockUser = { id: 1 }
  mockScope = 'backend:session-1'
  mockGetAllGrouped.mockResolvedValue(dataset())
  const detail = pending<never>()
  jest.mocked(getKnowledgeBase).mockReturnValueOnce(detail.promise)
  const { result } = renderHook(() => useKnowledgeSidebar())
  await waitFor(() => expect(result.current.hasLoaded).toBe(true))
  act(() => result.current.selectKb(result.current.allKnowledgeBases[0]))
  act(() => {
    if (action === 'selectGroup') result.current.selectGroup('shared')
    else if (action === 'selectSourceView') result.current.selectSourceView('external')
    else result.current[action]()
  })
  await act(async () => detail.resolve({ id: 1 } as never))
  expect(result.current.selectedKb).toBeNull()
  expect(result.current.selectedKbId).toBeNull()
})

it('rejects old mutation and refresh callbacks after scope changes, including reused library ids', async () => {
  mockUser = { id: 1 }
  mockScope = 'backend:session-1'
  mockGetAllGrouped.mockResolvedValue(dataset())
  const { result, rerender } = renderHook(() => useKnowledgeSidebar())
  await waitFor(() => expect(result.current.hasLoaded).toBe(true))
  const oldSync = result.current.syncConvertedKnowledgeBase
  const oldRefresh = result.current.refreshAll
  mockUser = { id: 2 }
  rerender()
  await waitFor(() => expect(result.current.hasLoaded).toBe(true))
  await act(async () => {
    oldSync({ ...result.current.allKnowledgeBases[0], name: 'Old user mutation' })
    await oldRefresh()
  })
  expect(result.current.allKnowledgeBases[0].name).toBe('Library 1')
  expect(result.current.isGroupsLoading).toBe(false)
})

it('does not resurrect a revoked library from a delayed detail response', async () => {
  mockUser = { id: 1 }
  mockScope = 'backend:session-1'
  mockGetAllGrouped.mockResolvedValueOnce(dataset())
  const detail = pending<never>()
  jest.mocked(getKnowledgeBase).mockReturnValueOnce(detail.promise)
  const { result } = renderHook(() => useKnowledgeSidebar())
  await waitFor(() => expect(result.current.hasLoaded).toBe(true))
  act(() => result.current.selectKb(result.current.allKnowledgeBases[0]))
  const next = dataset()
  next.personal.created_by_me = []
  mockGetAllGrouped.mockResolvedValueOnce(next)
  await act(async () => result.current.refreshAll())
  await act(async () => detail.resolve({ id: 1 } as never))
  expect(result.current.selectedKb).toBeNull()
})

it('keeps an undisclosed namespace unknown instead of inventing a team directory entry', async () => {
  mockUser = { id: 1 }
  mockScope = 'backend:session-1'
  const data = dataset()
  data.groups = []
  data.personal.shared_with_me = [
    row(5, {
      namespace: 'former-team',
    }),
  ]
  mockGetAllGrouped.mockResolvedValue(data)
  const { result } = renderHook(() => useKnowledgeSidebar())
  await waitFor(() => expect(result.current.hasLoaded).toBe(true))
  expect(result.current.groups.find(group => group.id === 'group-former-team')).toBeUndefined()
  const kb = result.current.visibleKnowledgeBases.personalSharedWithMe[0]
  expect(kb.namespace).toBe('former-team')
  expect(kb.namespace_level).toBeNull()
  expect(kb.namespace_display_name).toBeNull()
})

it('removes a confirmed inaccessible library from selection, rows, counts, and recent entries', async () => {
  mockUser = { id: 1 }
  mockScope = 'backend:session-1'
  mockGetAllGrouped.mockResolvedValue(dataset())
  jest.mocked(getKnowledgeBase).mockResolvedValueOnce({ id: 1 } as never)
  const { result } = renderHook(() => useKnowledgeSidebar())
  await waitFor(() => expect(result.current.hasLoaded).toBe(true))
  await act(async () => result.current.selectKb(result.current.allKnowledgeBases[0]))
  expect(result.current.recentItems.map(kb => kb.id)).toContain(1)
  act(() => result.current.removeInaccessibleKnowledgeBase(1))
  expect(result.current.selectedKb).toBeNull()
  expect(result.current.allKnowledgeBases.map(kb => kb.id)).not.toContain(1)
  expect(result.current.recentItems.map(kb => kb.id)).not.toContain(1)
  expect(result.current.summary?.total_count).toBe(3)
})

it('cannot restore revoked rows from a refresh issued before the access check', async () => {
  mockUser = { id: 1 }
  mockScope = 'backend:session-1'
  mockGetAllGrouped.mockResolvedValueOnce(dataset())
  const { result } = renderHook(() => useKnowledgeSidebar())
  await waitFor(() => expect(result.current.hasLoaded).toBe(true))
  const old = pending<AllGroupedKnowledgeResponse>()
  mockGetAllGrouped.mockReturnValueOnce(old.promise)
  let request!: Promise<void>
  act(() => {
    request = result.current.refreshAll()
  })
  act(() => result.current.removeInaccessibleKnowledgeBase(1))
  await act(async () => {
    old.resolve(dataset())
    await request
  })
  expect(result.current.allKnowledgeBases.map(kb => kb.id)).not.toContain(1)
  expect(result.current.isGroupsLoading).toBe(false)
})
