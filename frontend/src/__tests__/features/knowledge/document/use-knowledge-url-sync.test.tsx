import { renderHook, waitFor } from '@testing-library/react'
import { useKnowledgeUrlSync } from '@/features/knowledge/document/hooks/useKnowledgeUrlSync'
import type { KnowledgeBase } from '@/types/knowledge'

let mockPathname = '/knowledge/public/工程与算法'
const mockSearchParams = new URLSearchParams()
const mockRouter = { push: jest.fn(), replace: jest.fn() }
jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => mockSearchParams,
  useRouter: () => mockRouter,
}))

const company = { id: 202, name: '工程与算法', namespace: 'acme-org' } as KnowledgeBase
const team = { id: 101, name: '工程与算法', namespace: 'team' } as KnowledgeBase
const personal = { id: 303, name: '工程与算法', namespace: 'default' } as KnowledgeBase
const callbacks = {
  selectKb: jest.fn(),
  selectGroup: jest.fn(),
  selectGroups: jest.fn(),
  selectSourceView: jest.fn(),
  clearSelection: jest.fn(),
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPathname = '/knowledge/public/工程与算法'
  for (const key of Array.from(mockSearchParams.keys())) mockSearchParams.delete(key)
})

afterEach(() => jest.restoreAllMocks())

it('selects the company ID when newer team and personal KBs have the same name', async () => {
  renderHook(() =>
    useKnowledgeUrlSync({
      ...callbacks,
      allKnowledgeBases: [team, personal, company],
      organizationKnowledgeBases: [company],
      isGroupsLoading: false,
    })
  )
  await waitFor(() => expect(callbacks.selectKb).toHaveBeenCalledWith(company))
  expect(callbacks.selectKb).not.toHaveBeenCalledWith(team)
})

it('waits for loading, then resolves without a URL change', () => {
  const { result, rerender } = renderHook(
    ({ loading, organizations }) =>
      useKnowledgeUrlSync({
        ...callbacks,
        allKnowledgeBases: [team, personal, ...organizations],
        organizationKnowledgeBases: organizations,
        isGroupsLoading: loading,
      }),
    { initialProps: { loading: true, organizations: [] as KnowledgeBase[] } }
  )
  expect(callbacks.selectKb).not.toHaveBeenCalled()
  expect(result.current.kbResolution?.status).toBe('loading')
  rerender({ loading: false, organizations: [company] })
  expect(callbacks.selectKb).toHaveBeenCalledWith(company)
  expect(result.current.kbResolution?.status).toBe('resolved')
})

it('does not select a different scope when the company KB is missing', () => {
  const { result } = renderHook(() =>
    useKnowledgeUrlSync({
      ...callbacks,
      allKnowledgeBases: [team, personal],
      organizationKnowledgeBases: [],
      isGroupsLoading: false,
    })
  )
  expect(result.current.kbResolution?.status).toBe('not-found')
  expect(callbacks.selectKb).not.toHaveBeenCalled()
  expect(callbacks.clearSelection).toHaveBeenCalled()
})

it('rejects different IDs with the same company name and recovers when ambiguity is removed', () => {
  const duplicate = { ...company, id: 404 }
  const { result, rerender } = renderHook(
    ({ organizations }) =>
      useKnowledgeUrlSync({
        ...callbacks,
        allKnowledgeBases: [team, ...organizations],
        organizationKnowledgeBases: organizations,
        isGroupsLoading: false,
      }),
    { initialProps: { organizations: [company, duplicate] } }
  )
  expect(result.current.kbResolution?.status).toBe('ambiguous')
  expect(callbacks.selectKb).not.toHaveBeenCalled()
  rerender({ organizations: [company, company] })
  expect(result.current.kbResolution?.status).toBe('resolved')
  expect(callbacks.selectKb).toHaveBeenCalledWith(company)
})

it('keeps the company ID after reordering and renaming the team KB', () => {
  const { result, rerender } = renderHook(
    ({ all }) =>
      useKnowledgeUrlSync({
        ...callbacks,
        allKnowledgeBases: all,
        organizationKnowledgeBases: [company],
        isGroupsLoading: false,
      }),
    { initialProps: { all: [team, personal, company] } }
  )
  rerender({ all: [company, personal, { ...team, name: 'renamed' }] })
  expect(result.current.kbResolution).toEqual({ status: 'resolved', knowledgeBase: company })
  expect(callbacks.selectKb).toHaveBeenCalledTimes(1)
})

it('does not treat a failed list request as a missing KB', () => {
  const { result } = renderHook(() =>
    useKnowledgeUrlSync({
      ...callbacks,
      allKnowledgeBases: [],
      organizationKnowledgeBases: [],
      isGroupsLoading: false,
      hasLoadError: true,
    })
  )
  expect(result.current.kbResolution?.status).toBe('error')
  expect(callbacks.selectKb).not.toHaveBeenCalled()
})

it('retains only the already resolved route ID across refresh and failure', () => {
  const { result, rerender } = renderHook(
    ({ loading, error }) =>
      useKnowledgeUrlSync({
        ...callbacks,
        allKnowledgeBases: [team, company],
        organizationKnowledgeBases: [company],
        isGroupsLoading: loading,
        hasLoadError: error,
      }),
    { initialProps: { loading: false, error: false } }
  )
  expect(result.current.retainedKbId).toBe(202)
  rerender({ loading: true, error: false })
  expect(result.current.kbResolution?.status).toBe('loading')
  expect(result.current.retainedKbId).toBe(202)
  rerender({ loading: false, error: true })
  expect(result.current.kbResolution?.status).toBe('error')
  expect(result.current.retainedKbId).toBe(202)
  expect(callbacks.clearSelection).not.toHaveBeenCalled()
  mockPathname = '/knowledge/team/工程与算法'
  rerender({ loading: true, error: false })
  expect(result.current.retainedKbId).toBeUndefined()
})

it('keeps the clicked ID in its URL and resolves the same-name target after refresh', () => {
  const selected = { ...company, id: 404 }
  const pushState = jest.spyOn(window.history, 'pushState')
  const props = {
    ...callbacks,
    allKnowledgeBases: [company, selected],
    organizationKnowledgeBases: [company, selected],
    isGroupsLoading: false,
  }
  const { result, rerender, unmount } = renderHook(() => useKnowledgeUrlSync(props))
  result.current.navigateToKbViaHistory(selected, [
    { ...company, group_type: 'organization' },
    { ...selected, group_type: 'organization' },
  ])
  const url = new URL(String(pushState.mock.calls[0][2]), 'https://example.com')
  expect(url.searchParams.get('kb')).toBe('404')
  mockSearchParams.set('kb', '404')
  rerender()
  expect(callbacks.selectKb).toHaveBeenLastCalledWith(selected)
  unmount()
  callbacks.selectKb.mockClear()
  renderHook(() => useKnowledgeUrlSync(props))
  expect(callbacks.selectKb).toHaveBeenCalledWith(selected)
})

it('canonicalizes a stale name without losing document or task parameters', () => {
  const replaceState = jest.spyOn(window.history, 'replaceState')
  mockPathname = '/knowledge/public/旧名称/folder/doc.md'
  mockSearchParams.set('kb', '202')
  mockSearchParams.set('taskId', '123')
  mockSearchParams.set('documentId', '7')
  renderHook(() =>
    useKnowledgeUrlSync({
      ...callbacks,
      allKnowledgeBases: [company],
      organizationKnowledgeBases: [company],
      isGroupsLoading: false,
    })
  )
  expect(callbacks.selectKb).toHaveBeenCalledWith(company)
  const url = new URL(String(replaceState.mock.calls[0][2]), 'https://example.com')
  expect(decodeURIComponent(url.pathname)).toBe('/knowledge/public/工程与算法/folder/doc.md')
  expect(url.searchParams.get('kb')).toBe('202')
  expect(url.searchParams.get('taskId')).toBe('123')
  expect(url.searchParams.get('documentId')).toBe('7')
})

it('does not retain the old target when only the requested ID changes during loading', () => {
  mockSearchParams.set('kb', '202')
  const { result, rerender } = renderHook(
    ({ loading }) =>
      useKnowledgeUrlSync({
        ...callbacks,
        allKnowledgeBases: [company],
        organizationKnowledgeBases: [company],
        isGroupsLoading: loading,
      }),
    { initialProps: { loading: false } }
  )
  expect(result.current.retainedKbId).toBe(202)
  mockSearchParams.set('kb', '404')
  rerender({ loading: true })
  expect(result.current.retainedKbId).toBeUndefined()
})

it('lets Next synchronize the canonical ID before same-name candidates change', () => {
  const originalReplaceState = window.history.replaceState.bind(window.history)
  originalReplaceState({ __NA: true }, '', '/knowledge/public/工程与算法')
  jest.spyOn(window.history, 'replaceState').mockImplementation((data, unused, url) => {
    originalReplaceState(data, unused, url)
    // Next bypasses hook synchronization for its own internal history writes.
    if (data?.__NA || data?._N) return
    const next = new URL(String(url), window.location.origin)
    mockPathname = next.pathname
    for (const key of Array.from(mockSearchParams.keys())) mockSearchParams.delete(key)
    next.searchParams.forEach((value, key) => mockSearchParams.set(key, value))
  })
  const { result, rerender } = renderHook(
    ({ organizations }) =>
      useKnowledgeUrlSync({
        ...callbacks,
        allKnowledgeBases: organizations,
        organizationKnowledgeBases: organizations,
        isGroupsLoading: false,
      }),
    { initialProps: { organizations: [company] } }
  )
  expect(mockSearchParams.get('kb')).toBe('202')
  rerender({ organizations: [company, { ...company, id: 404 }] })
  expect(result.current.kbResolution).toEqual({ status: 'resolved', knowledgeBase: company })
})

it('clears a stale index-page selection when its ID is unavailable', () => {
  mockPathname = '/knowledge'
  mockSearchParams.set('kb', '999')
  renderHook(() =>
    useKnowledgeUrlSync({
      ...callbacks,
      allKnowledgeBases: [company],
      organizationKnowledgeBases: [company],
      isGroupsLoading: false,
    })
  )
  expect(callbacks.selectKb).not.toHaveBeenCalled()
  expect(callbacks.clearSelection).toHaveBeenCalled()
})
