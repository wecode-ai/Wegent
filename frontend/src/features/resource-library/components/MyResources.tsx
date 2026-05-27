// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { ResourceLibraryListing, ResourceLibraryTypeFilter } from '../types'
import { PublishResourceDialog } from './PublishResourceDialog'
import { ResourceDetailDrawer } from './ResourceDetailDrawer'
import { ResourceListingCard } from './ResourceListingCard'

interface MyResourcesProps {
  resourceType: ResourceLibraryTypeFilter
}

type MyResourcesTab = 'installed' | 'published'

const myResourcesTabs: MyResourcesTab[] = ['installed', 'published']
const MY_RESOURCES_PAGE_SIZE = 50

export function MyResources({ resourceType }: MyResourcesProps) {
  const { t } = useTranslation('resource-library')
  const { toast } = useToast()
  const [activeTab, setActiveTab] = useState<MyResourcesTab>('installed')
  const [listings, setListings] = useState<ResourceLibraryListing[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [selectedListing, setSelectedListing] = useState<ResourceLibraryListing | null>(null)
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const [isDetailLoading, setIsDetailLoading] = useState(false)
  const [installingIds, setInstallingIds] = useState<Set<number>>(() => new Set())
  const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)

  const loadResources = useCallback(async () => {
    setIsLoading(true)
    setHasError(false)
    try {
      if (activeTab === 'installed') {
        const response = await resourceLibraryApi.listMyInstalls({
          resourceType,
          page: 1,
          limit: MY_RESOURCES_PAGE_SIZE,
        })
        setListings(
          response.items
            .map(install => install.listing)
            .filter((listing): listing is ResourceLibraryListing => Boolean(listing))
            .map(listing => ({ ...listing, is_installed: true }))
        )
      } else {
        const response = await resourceLibraryApi.listMyPublished({
          resourceType,
          page: 1,
          limit: MY_RESOURCES_PAGE_SIZE,
        })
        setListings(response.items)
      }
    } catch {
      setHasError(true)
    } finally {
      setIsLoading(false)
    }
  }, [activeTab, resourceType])

  useEffect(() => {
    void loadResources()
  }, [loadResources, refreshVersion])

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

  const handleViewDetails = async (listing: ResourceLibraryListing) => {
    setSelectedListing(listing)
    setIsDetailOpen(true)
    setIsDetailLoading(true)
    try {
      const detail = await resourceLibraryApi.getListing(listing.id)
      setSelectedListing(activeTab === 'installed' ? { ...detail, is_installed: true } : detail)
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
      await loadResources()
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

  const handlePublished = () => {
    setActiveTab('published')
    setRefreshVersion(version => version + 1)
  }

  return (
    <div className="flex flex-col gap-4" data-testid="my-resources">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex rounded-lg border border-border bg-surface p-1" role="tablist">
          {myResourcesTabs.map(tab => {
            const isActive = activeTab === tab
            return (
              <Button
                key={tab}
                type="button"
                variant={isActive ? 'primary' : 'ghost'}
                className={cn('h-11 min-w-[44px] px-4 lg:h-9', isActive && 'border-primary')}
                aria-pressed={isActive}
                onClick={() => setActiveTab(tab)}
                data-testid={`my-resources-${tab}-tab`}
              >
                {t(`tabs.${tab}`)}
              </Button>
            )
          })}
        </div>

        <Button
          type="button"
          variant="primary"
          className="h-11 min-w-[44px] px-4 lg:h-9"
          onClick={() => setIsPublishDialogOpen(true)}
          data-testid="publish-resource-button"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('actions.publish')}
        </Button>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label={t('states.loading')}>
          {Array.from({ length: 3 }).map((_, index) => (
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
            onClick={() => void loadResources()}
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

      <PublishResourceDialog
        open={isPublishDialogOpen}
        resourceType={resourceType}
        onOpenChange={setIsPublishDialogOpen}
        onPublished={handlePublished}
      />
    </div>
  )
}
