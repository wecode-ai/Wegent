// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Bot, Code2, Compass, Eye, TrendingUp, UserPlus } from 'lucide-react'

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
      className="group flex min-h-[280px] flex-col overflow-hidden bg-base p-4 transition-colors hover:border-primary/40 hover:bg-hover sm:p-5"
      data-testid={`resource-listing-card-${listing.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-text-secondary group-hover:text-primary">
            <TypeIcon className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-1 text-xs font-medium text-primary">
              <Compass className="h-3.5 w-3.5" aria-hidden="true" />
              {t('discover.card.solution_label')}
            </div>
            <h3 className="truncate text-base font-semibold text-text-primary">{title}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Badge variant="info">{t(`filters.${listing.resource_type}`)}</Badge>
              {listing.current_version?.version && (
                <span className="text-xs text-text-muted">v{listing.current_version.version}</span>
              )}
            </div>
          </div>
        </div>
        {listing.install_count > 0 && (
          <div className="flex shrink-0 items-center gap-1 rounded-md bg-surface px-2 py-1 text-xs text-text-muted">
            <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
            {listing.install_count}
          </div>
        )}
      </div>

      <p className="mt-4 line-clamp-2 min-h-[40px] text-sm text-text-secondary">
        {listing.description || listing.name}
      </p>

      <div className="mt-4 rounded-lg border border-border bg-surface/70 p-3">
        <div className="text-xs font-medium text-text-muted">{t('discover.card.best_for')}</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {listing.tags.length > 0 ? (
            listing.tags.slice(0, 3).map(tag => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))
          ) : (
            <span className="text-xs text-text-muted">{t('discover.card.no_tags')}</span>
          )}
        </div>
        <div className="mt-3 text-xs text-text-muted">{t('discover.card.start_hint')}</div>
      </div>

      <div className="mt-auto pt-5">
        <div className="mb-3 flex items-center justify-between gap-3 text-xs text-text-muted">
          <span>{t('fields.updated_at')}</span>
          <span className="truncate">{formatUTCDate(listing.updated_at)}</span>
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
            aria-label={`${t('actions.view_usage')} ${title}`}
            data-testid={`view-resource-${listing.id}-button`}
          >
            <Eye className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">{t('actions.view_usage')}</span>
          </Button>
        </div>
      </div>
    </Card>
  )
}
