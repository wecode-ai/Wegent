// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Bot, Code2, Eye, UserPlus } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useTranslation } from '@/hooks/useTranslation'
import { formatUTCDate } from '@/lib/utils'
import type { ResourceLibraryListing, ResourceLibraryResourceType } from '../types'

interface ResourceListingCardProps {
  listing: ResourceLibraryListing
  isInstalling?: boolean
  onInstall: (listing: ResourceLibraryListing) => void
  onViewDetails: (listing: ResourceLibraryListing) => void
}

const typeIcons = {
  agent: Bot,
  skill: Code2,
} satisfies Record<ResourceLibraryResourceType, typeof Bot>

function getListingTitle(listing: ResourceLibraryListing) {
  return listing.display_name || listing.name
}

export function ResourceListingCard({
  listing,
  isInstalling = false,
  onInstall,
  onViewDetails,
}: ResourceListingCardProps) {
  const { t } = useTranslation('resource-library')
  const TypeIcon = typeIcons[listing.resource_type]
  const title = getListingTitle(listing)
  const installDisabled = listing.is_installed || isInstalling

  return (
    <Card
      className="flex min-h-[220px] flex-col gap-4 p-4"
      data-testid={`resource-listing-card-${listing.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-base text-text-secondary">
            <TypeIcon className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-text-primary">{title}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Badge variant="info">{t(`filters.${listing.resource_type}`)}</Badge>
              {listing.current_version?.version && (
                <span className="text-xs text-text-muted">v{listing.current_version.version}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <p className="line-clamp-2 min-h-[40px] text-sm text-text-secondary">
        {listing.description || listing.name}
      </p>

      {listing.tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {listing.tags.slice(0, 3).map(tag => (
            <Badge key={tag} variant="secondary">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      <div className="mt-auto flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
          <span>
            {t('fields.install_count')}: {listing.install_count}
          </span>
          <span>
            {t('fields.updated_at')}: {formatUTCDate(listing.updated_at)}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant={listing.is_installed ? 'secondary' : 'primary'}
            className="h-11 min-w-[44px] flex-1 lg:h-9"
            disabled={installDisabled}
            onClick={() => onInstall(listing)}
            aria-label={`${listing.is_installed ? t('actions.installed') : t('actions.install')} ${title}`}
            data-testid={`install-resource-${listing.id}-button`}
          >
            <UserPlus className="h-4 w-4" aria-hidden="true" />
            {listing.is_installed ? t('actions.installed') : t('actions.install')}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11 min-w-[44px] px-3 lg:h-9"
            onClick={() => onViewDetails(listing)}
            aria-label={`${t('actions.details')} ${title}`}
            data-testid={`view-resource-${listing.id}-button`}
          >
            <Eye className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">{t('actions.details')}</span>
          </Button>
        </div>
      </div>
    </Card>
  )
}
