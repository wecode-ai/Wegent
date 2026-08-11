// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { FormEvent, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { RefreshCw, Search } from 'lucide-react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  buildTeamTargetHref,
  getBindModesTargetPage,
} from '@/features/tasks/components/selector/team-selector-utils'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { getResourceSearchPlaceholderKey } from '../resourceSearch'
import type { ResourceLibraryListing, ResourceLibraryTypeFilter } from '../types'
import { getMarketplaceTagLabel, useMarketplaceTags } from '../useMarketplaceTags'
import { ResourceDetailDrawer } from './ResourceDetailDrawer'
import { ResourceListingCard } from './ResourceListingCard'

interface DiscoverResourcesProps {
  resourceType: ResourceLibraryTypeFilter
  targetNamespace?: string
  leadingFilterControls?: ReactNode
  hideSearch?: boolean
  systemOnly?: boolean
}

const RESOURCE_LIBRARY_PAGE_SIZE = 20
const MARKETPLACE_KEYWORD_PARAM = 'keyword'
const MARKETPLACE_TAG_PARAM = 'tag'

function isVisibleListing(listing: ResourceLibraryListing, targetNamespace: string) {
  if (listing.resource_type === 'mcp') return false
  return !(
    targetNamespace !== 'default' &&
    listing.resource_type === 'agent' &&
    listing.publisher_user_id === 0
  )
}

function buildAgentUseHref(listing: ResourceLibraryListing, teamId: number): string {
  return buildTeamTargetHref(
    getBindModesTargetPage(listing.bind_modes, 'all'),
    new URLSearchParams({ teamId: String(teamId) })
  )
}

export function DiscoverResources({
  resourceType,
  targetNamespace = 'default',
  leadingFilterControls,
  hideSearch = false,
  systemOnly = false,
}: DiscoverResourcesProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { t, i18n } = useTranslation('resource-library')
  const { toast } = useToast()
  const [listings, setListings] = useState<ResourceLibraryListing[]>([])
  const keywordParam = searchParams.get(MARKETPLACE_KEYWORD_PARAM)?.trim() || ''
  const tagParam = searchParams.get(MARKETPLACE_TAG_PARAM)?.trim() || ''
  const [searchInput, setSearchInput] = useState(keywordParam)
  const [keyword, setKeyword] = useState(keywordParam)
  const [selectedTag, setSelectedTag] = useState(tagParam)
  const { items: marketplaceTags } = useMarketplaceTags()
  const enabledMarketplaceTags = marketplaceTags.filter(item => item.enabled)
  const marketplaceTagLabels = Object.fromEntries(
    marketplaceTags.map(item => [item.id, getMarketplaceTagLabel(item, i18n.language)])
  )
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
  const loadMoreTriggerRef = useRef<HTMLDivElement | null>(null)
  const listingGridClassName = 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'

  const replaceMarketplaceParams = useCallback(
    (updates: { keyword?: string; tag?: string }) => {
      const params = new URLSearchParams(searchParams.toString())

      if (updates.keyword !== undefined) {
        if (updates.keyword) {
          params.set(MARKETPLACE_KEYWORD_PARAM, updates.keyword)
        } else {
          params.delete(MARKETPLACE_KEYWORD_PARAM)
        }
      }
      if (updates.tag !== undefined) {
        if (updates.tag) {
          params.set(MARKETPLACE_TAG_PARAM, updates.tag)
        } else {
          params.delete(MARKETPLACE_TAG_PARAM)
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

  useEffect(() => {
    setSelectedTag(tagParam)
  }, [tagParam])

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
          ...(keyword ? { keyword } : {}),
          ...(selectedTag ? { tags: [selectedTag] } : {}),
          ...(systemOnly && !selectedTag
            ? resourceType === 'agent' || resourceType === 'skill'
              ? { featuredOnly: true }
              : { systemOnly: true }
            : {}),
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
    [keyword, resourceType, selectedTag, systemOnly, targetNamespace]
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

  const handleTagChange = (tag: string) => {
    setSelectedTag(tag)
    replaceMarketplaceParams({ tag })
  }

  const handleLoadMore = useCallback(() => {
    if (!nextCursor || isLoadingMore) return
    void loadListings(nextCursor, true)
  }, [isLoadingMore, loadListings, nextCursor])

  useEffect(() => {
    const trigger = loadMoreTriggerRef.current
    if (!trigger || !hasMore || isLoadingMore || loadMoreFailed) return

    const observer = new IntersectionObserver(
      entries => {
        const entry = entries[0]
        if (!entry?.isIntersecting) return

        observer.unobserve(entry.target)
        handleLoadMore()
      },
      { rootMargin: '200px 0px' }
    )

    observer.observe(trigger)
    return () => observer.disconnect()
  }, [handleLoadMore, hasMore, isLoadingMore, loadMoreFailed])

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
      <div
        className={
          hideSearch && !leadingFilterControls
            ? 'flex justify-start'
            : 'flex flex-col gap-3 rounded-xl border border-border bg-surface p-3 lg:flex-row lg:items-end'
        }
        data-testid="marketplace-toolbar"
      >
        {leadingFilterControls}
        <div className="flex max-w-full flex-wrap gap-2" data-testid="marketplace-tag-filter">
          <Button
            type="button"
            size="sm"
            className="min-h-11 min-w-11 md:min-h-9 md:min-w-0"
            variant={selectedTag ? 'outline' : 'primary'}
            onClick={() => handleTagChange('')}
            aria-pressed={!selectedTag}
            data-testid="marketplace-tag-filter-all"
          >
            {t(systemOnly ? 'marketplace_tags.featured' : 'marketplace_tags.all')}
          </Button>
          {enabledMarketplaceTags.map(item => (
            <Button
              key={item.id}
              type="button"
              size="sm"
              className="min-h-11 min-w-11 md:min-h-9 md:min-w-0"
              variant={selectedTag === item.id ? 'primary' : 'outline'}
              onClick={() => handleTagChange(item.id)}
              aria-pressed={selectedTag === item.id}
              data-testid={`marketplace-tag-filter-${item.id}`}
            >
              {getMarketplaceTagLabel(item, i18n.language)}
            </Button>
          ))}
        </div>
        {!hideSearch && (
          <form className="flex flex-1 flex-col gap-2 sm:flex-row" onSubmit={handleSearch}>
            <Input
              value={searchInput}
              onChange={event => setSearchInput(event.target.value)}
              placeholder={t(getResourceSearchPlaceholderKey(resourceType))}
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

      {isLoading ? (
        <div className={listingGridClassName} aria-label={t('states.loading')}>
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} className="h-[180px] rounded-lg" />
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
              tagLabels={marketplaceTagLabels}
            />
          ))}
        </div>
      )}

      {!isLoading && !hasError && listings.length > 0 && hasMore && (
        <div
          ref={loadMoreTriggerRef}
          className="flex min-h-10 items-center justify-center pt-2"
          data-testid="resource-library-load-more-trigger"
        >
          {loadMoreFailed ? (
            <Button
              type="button"
              variant="outline"
              className="h-10 min-w-28"
              onClick={handleLoadMore}
              disabled={!nextCursor}
              data-testid="resource-library-load-more"
            >
              {t('actions.retry')}
            </Button>
          ) : (
            isLoadingMore && (
              <RefreshCw
                className="h-5 w-5 animate-spin text-text-secondary"
                aria-label={t('states.loading')}
              />
            )
          )}
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
        tagLabels={marketplaceTagLabels}
      />
    </div>
  )
}
