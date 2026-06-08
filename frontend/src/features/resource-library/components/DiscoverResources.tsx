// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { RefreshCw, Search, Sparkles } from 'lucide-react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ResourceManagementLayout } from '@/features/settings/components/resource-management/ResourceManagementLayout'
import { useTeamContext } from '@/contexts/TeamContext'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import type { ResourceLibraryDiscoveryConfig, ResourceLibraryListing } from '../types'
import { DiscoverAssistantDrawer } from './DiscoverAssistantDrawer'
import { ResourceDetailDrawer } from './ResourceDetailDrawer'
import { ResourceListingCard } from './ResourceListingCard'

const RESOURCE_LIBRARY_PAGE_SIZE = 50

export function DiscoverResources() {
  const { t } = useTranslation('resource-library')
  const { toast } = useToast()
  const { teams, isTeamsLoading, refreshTeams } = useTeamContext()
  const [listings, setListings] = useState<ResourceLibraryListing[]>([])
  const [searchInput, setSearchInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [selectedListing, setSelectedListing] = useState<ResourceLibraryListing | null>(null)
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const [isDetailLoading, setIsDetailLoading] = useState(false)
  const [isAssistantOpen, setIsAssistantOpen] = useState(false)
  const [discoveryConfig, setDiscoveryConfig] = useState<ResourceLibraryDiscoveryConfig | null>(
    null
  )
  const [installingIds, setInstallingIds] = useState<Set<number>>(() => new Set())

  const loadListings = useCallback(async () => {
    setIsLoading(true)
    setHasError(false)
    try {
      const response = await resourceLibraryApi.listListings({
        resourceType: 'all',
        ...(keyword ? { keyword } : {}),
        page: 1,
        limit: RESOURCE_LIBRARY_PAGE_SIZE,
      })
      setListings(response.items)
    } catch {
      setHasError(true)
    } finally {
      setIsLoading(false)
    }
  }, [keyword])

  useEffect(() => {
    void loadListings()
  }, [loadListings])

  useEffect(() => {
    let isMounted = true

    void resourceLibraryApi
      .getDiscoveryConfig()
      .then(config => {
        if (isMounted) {
          setDiscoveryConfig(config)
        }
      })
      .catch(() => {
        if (isMounted) {
          setDiscoveryConfig(null)
        }
      })

    return () => {
      isMounted = false
    }
  }, [])

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

  const openAssistant = (prompt = '') => {
    const trimmedPrompt = prompt.trim()
    if (typeof window !== 'undefined') {
      if (trimmedPrompt) {
        sessionStorage.setItem(
          'pendingTaskPrompt',
          JSON.stringify({ prompt: trimmedPrompt, timestamp: Date.now() })
        )
      } else {
        sessionStorage.removeItem('pendingTaskPrompt')
      }
    }
    setIsAssistantOpen(true)
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
      const install = await resourceLibraryApi.installListing(listing.id, {})
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
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4" data-testid="discover-resources">
      <ResourceManagementLayout
        title={t('discover.title')}
        description={t('discover.description')}
        actions={
          <div className="flex w-full flex-col gap-2 lg:w-auto lg:flex-row lg:items-center">
            <Button
              type="button"
              variant="outline"
              className="h-11 min-w-[44px] shrink-0 px-4 md:h-10"
              onClick={() => openAssistant()}
              data-testid="open-discover-assistant-button"
            >
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              {t('discover.assistant.action')}
            </Button>
            <form
              className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-[440px] sm:flex-row"
              onSubmit={handleSearch}
              data-testid="discover-resources-toolbar"
            >
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
                className="h-11 min-w-[44px] px-4 sm:w-auto md:h-10"
                aria-label={t('actions.search')}
                data-testid="resource-library-search-button"
              >
                <Search className="h-4 w-4" aria-hidden="true" />
                {t('actions.search')}
              </Button>
            </form>
          </div>
        }
        filters={null}
        data-testid="resource-market-section"
      >
        <div
          className="flex flex-col gap-4 rounded-lg border border-border bg-surface/70 p-4 sm:flex-row sm:items-center sm:justify-between"
          data-testid="discover-assistant-callout"
        >
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-base text-primary">
              <Sparkles className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-text-primary">
                {t('discover.assistant.callout_title')}
              </h3>
              <p className="mt-1 text-sm text-text-secondary">
                {t('discover.assistant.callout_description')}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
            {[
              t('discover.assistant.prompts.weekly_report'),
              t('discover.assistant.prompts.code_review'),
              t('discover.assistant.prompts.doc_summary'),
            ].map(prompt => (
              <Button
                key={prompt}
                type="button"
                variant="outline"
                className="h-9 px-3"
                onClick={() => openAssistant(prompt)}
              >
                {prompt}
              </Button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div
            className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3"
            aria-label={t('states.loading')}
          >
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-[300px] rounded-lg" />
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
          <div
            className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3"
            data-testid="resource-library-list"
          >
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
      </ResourceManagementLayout>

      <DiscoverAssistantDrawer
        open={isAssistantOpen}
        teams={teams}
        isTeamsLoading={isTeamsLoading}
        assistantTeamRef={discoveryConfig?.assistant_team_ref ?? null}
        onOpenChange={setIsAssistantOpen}
        onRefreshTeams={refreshTeams}
      />

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
