// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { RefreshCw, Search } from 'lucide-react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import type { ResourceLibraryListing, ResourceLibraryTypeFilter } from '../types'
import { ResourceDetailDrawer } from './ResourceDetailDrawer'
import { ResourceListingCard } from './ResourceListingCard'

interface DiscoverResourcesProps {
  resourceType: ResourceLibraryTypeFilter
  toolbarStart?: ReactNode
}

const RESOURCE_LIBRARY_PAGE_SIZE = 50

function isVisibleListing(listing: ResourceLibraryListing) {
  return listing.resource_type !== 'mcp'
}

export function DiscoverResources({ resourceType, toolbarStart }: DiscoverResourcesProps) {
  const { t } = useTranslation('resource-library')
  const { toast } = useToast()
  const [listings, setListings] = useState<ResourceLibraryListing[]>([])
  const [searchInput, setSearchInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [selectedListing, setSelectedListing] = useState<ResourceLibraryListing | null>(null)
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const [isDetailLoading, setIsDetailLoading] = useState(false)
  const [installingIds, setInstallingIds] = useState<Set<number>>(() => new Set())

  const loadListings = useCallback(async () => {
    setIsLoading(true)
    setHasError(false)
    try {
      const response = await resourceLibraryApi.listListings({
        resourceType,
        keyword: keyword || undefined,
        page: 1,
        limit: RESOURCE_LIBRARY_PAGE_SIZE,
      })
      setListings(response.items.filter(isVisibleListing))
    } catch {
      setHasError(true)
    } finally {
      setIsLoading(false)
    }
  }, [keyword, resourceType])

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
    setKeyword(searchInput.trim())
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
    if (listing.is_installed || installingIds.has(listing.id)) {
      return
    }

    markInstalling(listing.id, true)
    try {
      const install = await resourceLibraryApi.installListing(listing.id, {
        targetNamespace: 'default',
      })
      markListingInstalled(listing.id)
      toast({
        title: install.requires_configuration
          ? t('messages.install_requires_configuration')
          : t('messages.install_success'),
      })
      await loadListings()
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
      <form
        className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between"
        onSubmit={handleSearch}
        data-testid="discover-resources-toolbar"
      >
        {toolbarStart && <div className="flex flex-wrap items-center gap-2">{toolbarStart}</div>}

        <div className="flex flex-col gap-2 sm:flex-row lg:ml-auto lg:w-full lg:min-w-[360px] lg:max-w-xl lg:flex-none">
          <Input
            value={searchInput}
            onChange={event => setSearchInput(event.target.value)}
            placeholder={t('search.placeholder')}
            className="h-11 flex-1 sm:h-10"
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
        </div>
      </form>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label={t('states.loading')}>
          {Array.from({ length: 6 }).map((_, index) => (
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
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {listings.map(listing => (
            <ResourceListingCard
              key={listing.id}
              listing={listing}
              isInstalling={installingIds.has(listing.id)}
              onInstall={handleInstall}
              onViewDetails={handleViewDetails}
            />
          ))}
        </div>
      )}

      <ResourceDetailDrawer
        open={isDetailOpen}
        listing={selectedListing}
        isLoading={isDetailLoading}
        isInstalling={selectedListing ? installingIds.has(selectedListing.id) : false}
        onOpenChange={setIsDetailOpen}
        onInstall={handleInstall}
      />
    </div>
  )
}
