// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { FormEvent, useCallback, useEffect, useState, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { RefreshCw, Search } from 'lucide-react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { buildChatCodeHref } from '@/config/coding-route'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import type { ResourceLibraryListing, ResourceLibraryTypeFilter } from '../types'
import { ResourceDetailDrawer } from './ResourceDetailDrawer'
import { ResourceListingCard } from './ResourceListingCard'

interface DiscoverResourcesProps {
  resourceType: ResourceLibraryTypeFilter
  targetNamespace?: string
  leadingFilterControls?: ReactNode
  hideSearch?: boolean
}

const RESOURCE_LIBRARY_PAGE_SIZE = 20
const MARKETPLACE_KEYWORD_PARAM = 'keyword'

function isVisibleListing(listing: ResourceLibraryListing, targetNamespace: string) {
  if (listing.resource_type === 'mcp') return false
  if (targetNamespace === 'default' && listing.resource_type === 'skill' && listing.is_installed) {
    return false
  }
  return !(
    targetNamespace !== 'default' &&
    listing.resource_type === 'agent' &&
    listing.publisher_user_id === 0
  )
}

function buildAgentUseHref(listing: ResourceLibraryListing, teamId: number): string {
  const isCodeOnlyAgent = listing.bind_modes.length === 1 && listing.bind_modes.includes('code')
  if (!isCodeOnlyAgent) {
    return `/chat?teamId=${teamId}`
  }

  return buildChatCodeHref(
    new URLSearchParams([
      ['agent', 'code'],
      ['teamId', String(teamId)],
    ])
  )
}

export function DiscoverResources({
  resourceType,
  targetNamespace = 'default',
  leadingFilterControls,
  hideSearch = false,
}: DiscoverResourcesProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { t } = useTranslation('resource-library')
  const { toast } = useToast()
  const [listings, setListings] = useState<ResourceLibraryListing[]>([])
  const keywordParam = searchParams.get(MARKETPLACE_KEYWORD_PARAM)?.trim() || ''
  const [searchInput, setSearchInput] = useState(keywordParam)
  const [keyword, setKeyword] = useState(keywordParam)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [loadMoreFailed, setLoadMoreFailed] = useState(false)
  const [hasError, setHasError] = useState(false)
  const [selectedListing, setSelectedListing] = useState<ResourceLibraryListing | null>(null)
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const [isDetailLoading, setIsDetailLoading] = useState(false)
  const [installingIds, setInstallingIds] = useState<Set<number>>(() => new Set())
  const listingGridClassName = 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'

  const replaceMarketplaceParams = useCallback(
    (updates: { keyword?: string }) => {
      const params = new URLSearchParams(searchParams.toString())

      if (updates.keyword !== undefined) {
        if (updates.keyword) {
          params.set(MARKETPLACE_KEYWORD_PARAM, updates.keyword)
        } else {
          params.delete(MARKETPLACE_KEYWORD_PARAM)
        }
      }

      const query = params.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  useEffect(() => {
    setSearchInput(keywordParam)
    setKeyword(keywordParam)
  }, [keywordParam])

  const loadListings = useCallback(
    async (cursor?: string, append = false) => {
      if (append) {
        setIsLoadingMore(true)
        setLoadMoreFailed(false)
      } else {
        setIsLoading(true)
        setHasError(false)
        setLoadMoreFailed(false)
        setNextCursor(null)
        setHasMore(false)
      }
      try {
        const response = await resourceLibraryApi.listListings({
          resourceType,
          keyword: keyword || undefined,
          targetNamespace,
          cursor,
          limit: RESOURCE_LIBRARY_PAGE_SIZE,
        })
        const nextItems = response.items.filter(listing =>
          isVisibleListing(listing, targetNamespace)
        )
        if (append) {
          setListings(previous => {
            const existingIds = new Set(previous.map(item => item.id))
            return [...previous, ...nextItems.filter(item => !existingIds.has(item.id))]
          })
        } else {
          setListings(nextItems)
        }
        setNextCursor(response.next_cursor)
        setHasMore(response.has_more)
      } catch {
        if (append) {
          setLoadMoreFailed(true)
        } else {
          setListings([])
          setNextCursor(null)
          setHasMore(false)
          setHasError(true)
        }
      } finally {
        if (append) {
          setIsLoadingMore(false)
        } else {
          setIsLoading(false)
        }
      }
    },
    [keyword, resourceType, targetNamespace]
  )

  useEffect(() => {
    void loadListings()
  }, [loadListings])

  const markInstalling = (listingId: number, installing: boolean) => {
    setInstallingIds(previous => {
      const next = new Set(previous)
      if (installing) {
        next.add(listingId)
      } else {
        next.delete(listingId)
      }
      return next
    })
  }

  const markListingInstalled = (listingId: number) => {
    setListings(previous =>
      previous.map(item =>
        item.id === listingId
          ? {
              ...item,
              is_installed: true,
              install_count: item.install_count + 1,
            }
          : item
      )
    )
    setSelectedListing(previous =>
      previous?.id === listingId
        ? {
            ...previous,
            is_installed: true,
            install_count: previous.install_count + 1,
          }
        : previous
    )
  }

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextKeyword = searchInput.trim()
    setKeyword(nextKeyword)
    replaceMarketplaceParams({ keyword: nextKeyword })
  }

  const handleLoadMore = () => {
    if (!nextCursor || isLoadingMore) return
    void loadListings(nextCursor, true)
  }

  const handleViewDetails = async (listing: ResourceLibraryListing) => {
    setSelectedListing(listing)
    setIsDetailOpen(true)
    setIsDetailLoading(true)
    try {
      const detail = await resourceLibraryApi.getListing(listing.id)
      setSelectedListing(detail)
    } catch {
      toast({
        title: t('states.error'),
        variant: 'destructive',
      })
    } finally {
      setIsDetailLoading(false)
    }
  }

  const handleInstall = async (listing: ResourceLibraryListing) => {
    if (
      ['model', 'shell', 'retriever'].includes(listing.resource_type) &&
      listing.publisher_user_id === 0
    ) {
      return
    }

    const isDirectlyUsableSystemAgent =
      listing.resource_type === 'agent' &&
      listing.publisher_user_id === 0 &&
      targetNamespace === 'default'

    if (isDirectlyUsableSystemAgent) {
      router.push(buildAgentUseHref(listing, listing.id))
      return
    }

    if (
      installingIds.has(listing.id) ||
      (listing.resource_type !== 'agent' && listing.is_installed && targetNamespace === 'default')
    ) {
      return
    }

    markInstalling(listing.id, true)
    try {
      const install = await resourceLibraryApi.installListing(listing.id, {
        targetNamespace,
      })
      if (targetNamespace === 'default') {
        markListingInstalled(listing.id)
      }
      const isPersonalAgentUse = listing.resource_type === 'agent' && targetNamespace === 'default'
      if (!isPersonalAgentUse) {
        toast({
          title: t('messages.install_success'),
        })
      }
      await loadListings()
      const teamId = install.installed_reference.team_id
      if (listing.resource_type === 'agent' && targetNamespace === 'default' && teamId) {
        router.push(buildAgentUseHref(listing, teamId))
      }
    } catch (error) {
      toast({
        title: t('messages.install_failed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      markInstalling(listing.id, false)
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="discover-resources">
      {(!hideSearch || leadingFilterControls) && (
        <div
          className={
            hideSearch && !leadingFilterControls
              ? 'flex justify-end'
              : 'flex flex-col gap-3 rounded-xl border border-border bg-surface p-3 lg:flex-row lg:items-end'
          }
          data-testid="marketplace-toolbar"
        >
          {leadingFilterControls}
          {!hideSearch && (
            <form className="flex flex-1 flex-col gap-2 sm:flex-row" onSubmit={handleSearch}>
              <Input
                value={searchInput}
                onChange={event => setSearchInput(event.target.value)}
                placeholder={t('search.placeholder')}
                className="h-11 bg-base sm:h-10"
                data-testid="resource-library-search-input"
              />
              <Button
                type="submit"
                variant="outline"
                className="h-11 min-w-[44px] px-4 sm:w-auto lg:h-10"
                aria-label={t('actions.search')}
                data-testid="resource-library-search-button"
              >
                <Search className="h-4 w-4" aria-hidden="true" />
                {t('actions.search')}
              </Button>
            </form>
          )}
        </div>
      )}

      {isLoading ? (
        <div className={listingGridClassName} aria-label={t('states.loading')}>
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} className="h-[220px] rounded-lg" />
          ))}
        </div>
      ) : hasError ? (
        <div className="flex min-h-[260px] flex-col items-center justify-center gap-3 rounded-lg border border-border bg-surface p-6 text-center">
          <p className="text-sm text-text-secondary">{t('states.error')}</p>
          <Button
            type="button"
            variant="outline"
            className="h-11 min-w-[44px]"
            onClick={() => void loadListings()}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {t('actions.retry')}
          </Button>
        </div>
      ) : listings.length === 0 ? (
        <div className="flex min-h-[260px] items-center justify-center rounded-lg border border-border bg-surface p-6 text-sm text-text-secondary">
          {t('states.empty')}
        </div>
      ) : (
        <div className={listingGridClassName} data-testid="discover-resource-grid">
          {listings.map(listing => (
            <ResourceListingCard
              key={listing.id}
              listing={listing}
              isInstalling={installingIds.has(listing.id)}
              onInstall={handleInstall}
              onViewDetails={handleViewDetails}
              targetNamespace={targetNamespace}
              compact={resourceType === 'skill'}
            />
          ))}
        </div>
      )}

      {!isLoading && !hasError && listings.length > 0 && hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            type="button"
            variant="outline"
            className="h-10 min-w-28"
            onClick={handleLoadMore}
            disabled={isLoadingMore || !nextCursor}
            data-testid="resource-library-load-more"
          >
            {isLoadingMore && <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {t(loadMoreFailed ? 'actions.retry' : 'actions.load_more')}
          </Button>
        </div>
      )}

      <ResourceDetailDrawer
        open={isDetailOpen}
        listing={selectedListing}
        isLoading={isDetailLoading}
        isInstalling={selectedListing ? installingIds.has(selectedListing.id) : false}
        onOpenChange={setIsDetailOpen}
        onInstall={handleInstall}
        targetNamespace={targetNamespace}
      />
    </div>
  )
}
