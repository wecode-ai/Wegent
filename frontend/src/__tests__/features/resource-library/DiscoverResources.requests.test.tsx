// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { DiscoverResources } from '@/features/resource-library/components/DiscoverResources'
import type { ResourceLibraryListing } from '@/features/resource-library/types'

let mockSearchParams = new URLSearchParams()
const mockReplace = jest.fn()
let intersectionCallback: IntersectionObserverCallback

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => '/resource-library',
  useSearchParams: () => mockSearchParams,
}))
jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: { listListings: jest.fn() },
}))
jest.mock('@/contexts/TeamContext', () => ({ useTeamContext: () => ({}) }))
jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({}) }))
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}))
jest.mock('@/features/resource-library/useMarketplaceTags', () => ({
  useMarketplaceTags: () => ({ items: [] }),
}))
jest.mock('@/features/resource-library/components/ResourceDetailDrawer', () => ({
  ResourceDetailDrawer: () => null,
}))
jest.mock('@/features/resource-library/components/ResourceListingCard', () => ({
  ResourceListingCard: ({ listing }: { listing: ResourceLibraryListing }) => (
    <div>{listing.display_name}</div>
  ),
}))

type ListingsResponse = Awaited<ReturnType<typeof resourceLibraryApi.listListings>>

function deferredResponse() {
  let resolve!: (value: ListingsResponse) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<ListingsResponse>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function response(name: string, cursor: string | null = null): ListingsResponse {
  return {
    items: [
      { id: name.length, display_name: name, resource_type: 'skill' } as ResourceLibraryListing,
    ],
    has_more: Boolean(cursor),
    next_cursor: cursor,
    limit: 20,
  }
}

const listListings = jest.mocked(resourceLibraryApi.listListings)

describe('DiscoverResources request ordering', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearchParams = new URLSearchParams('type=skill')
    globalThis.IntersectionObserver = jest.fn(callback => {
      intersectionCallback = callback
      return { observe: jest.fn(), unobserve: jest.fn(), disconnect: jest.fn() }
    }) as unknown as typeof IntersectionObserver
  })

  it.each(['success', 'error'] as const)(
    'keeps search results when an older full-list request finishes with %s',
    async outcome => {
      const initial = deferredResponse()
      listListings.mockReturnValueOnce(initial.promise).mockResolvedValueOnce(response('回看'))
      const { rerender } = render(<DiscoverResources resourceType="skill" hideSearch />)

      mockSearchParams = new URLSearchParams('type=skill&keyword=回看')
      rerender(<DiscoverResources resourceType="skill" hideSearch />)
      expect(await screen.findByText('回看')).toBeInTheDocument()
      expect(listListings).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: '回看' }))

      await act(async () => {
        if (outcome === 'success') initial.resolve(response('All skills', 'old-page'))
        else initial.reject(new Error('Old request failed'))
      })

      expect(screen.getByText('回看')).toBeInTheDocument()
      expect(screen.queryByText('All skills')).not.toBeInTheDocument()
      expect(screen.queryByText('states.error')).not.toBeInTheDocument()
      expect(screen.queryByTestId('resource-library-load-more-trigger')).not.toBeInTheDocument()
    }
  )

  it('keeps the search loading until its own response arrives', async () => {
    const initial = deferredResponse()
    const search = deferredResponse()
    listListings.mockReturnValueOnce(initial.promise).mockReturnValueOnce(search.promise)
    render(<DiscoverResources resourceType="skill" />)
    fireEvent.change(screen.getByTestId('resource-library-search-input'), {
      target: { value: '回看' },
    })
    fireEvent.click(screen.getByTestId('resource-library-search-button'))

    await act(async () => initial.resolve(response('All skills')))
    expect(screen.getByLabelText('states.loading')).toBeInTheDocument()
    expect(screen.queryByText('All skills')).not.toBeInTheDocument()

    await act(async () => search.resolve(response('回看')))
    expect(screen.getByText('回看')).toBeInTheDocument()
  })

  it('discards an old page and allows pagination for the new search', async () => {
    const oldPage = deferredResponse()
    listListings
      .mockResolvedValueOnce(response('All skills', 'old-page'))
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce(response('回看', 'search-page'))
      .mockResolvedValueOnce(response('回看 next page'))
    const { rerender } = render(<DiscoverResources resourceType="skill" hideSearch />)
    await screen.findByText('All skills')

    const loadNextPage = () => {
      act(() => {
        intersectionCallback(
          [
            {
              isIntersecting: true,
              target: screen.getByTestId('resource-library-load-more-trigger'),
            } as unknown as IntersectionObserverEntry,
          ],
          {} as IntersectionObserver
        )
      })
    }
    loadNextPage()
    mockSearchParams = new URLSearchParams('type=skill&keyword=回看')
    rerender(<DiscoverResources resourceType="skill" hideSearch />)
    await screen.findByText('回看')

    loadNextPage()
    expect(await screen.findByText('回看 next page')).toBeInTheDocument()
    expect(listListings).toHaveBeenLastCalledWith(
      expect.objectContaining({ keyword: '回看', cursor: 'search-page' })
    )
    await act(async () => oldPage.resolve(response('Old unrelated page')))
    expect(screen.queryByText('Old unrelated page')).not.toBeInTheDocument()
    expect(screen.getByText('回看')).toBeInTheDocument()
  })
})
