// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  Bot,
  BrainCircuit,
  Check,
  Code2,
  Database,
  Loader2,
  Plus,
  Server,
  SquareTerminal,
} from 'lucide-react'

import { ResourceCardFooter } from '@/components/common/ResourceCardFooter'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { ResourceLibraryListing, ResourceLibraryResourceType } from '../types'

interface ResourceListingCardProps {
  listing: ResourceLibraryListing
  isInstalling?: boolean
  onInstall: (listing: ResourceLibraryListing) => void
  onViewDetails: (listing: ResourceLibraryListing) => void
  targetNamespace?: string
  compact?: boolean
}

const typeIcons = {
  agent: Bot,
  skill: Code2,
  model: BrainCircuit,
  shell: SquareTerminal,
  retriever: Database,
  mcp: Server,
} satisfies Record<ResourceLibraryResourceType, typeof Bot>

function getListingTitle(listing: ResourceLibraryListing) {
  return listing.display_name || listing.name
}

function getPublisher(listing: ResourceLibraryListing, officialPublisher: string) {
  if (listing.publisher_user_id === 0) return officialPublisher
  return listing.publisher_user_name?.trim() || listing.publisher_namespace?.trim() || null
}

export function ResourceListingCard({
  listing,
  isInstalling = false,
  onInstall,
  onViewDetails,
  targetNamespace = 'default',
  compact = false,
}: ResourceListingCardProps) {
  const { t } = useTranslation('resource-library')
  const TypeIcon = typeIcons[listing.resource_type]
  const title = getListingTitle(listing)
  const isAgent = listing.resource_type === 'agent'
  const isDirectlyUsableSystemCapability =
    ['model', 'shell', 'retriever'].includes(listing.resource_type) &&
    listing.publisher_user_id === 0
  const isPersonalTarget = targetNamespace === 'default'
  const isCodeOnlyAgent =
    isAgent && listing.bind_modes.length === 1 && listing.bind_modes.includes('code')
  const publisher = getPublisher(listing, t('fields.official_publisher'))
  const installDisabled = (!isAgent && listing.is_installed && isPersonalTarget) || isInstalling
  const actionLabel = isAgent
    ? isPersonalTarget
      ? t(isCodeOnlyAgent ? 'common:teams.go_to_code' : 'common:teams.go_to_chat')
      : t('actions.add')
    : listing.is_installed && isPersonalTarget
      ? t('actions.added')
      : t('actions.add')
  return (
    <Card
      className={cn(
        'group relative flex min-h-[160px] flex-col gap-4 overflow-hidden rounded-xl border-border bg-surface p-4 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md',
        compact && 'min-h-[180px]'
      )}
      data-testid={`resource-listing-card-${listing.id}`}
    >
      <button
        type="button"
        className="absolute inset-0 z-10 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        onClick={() => onViewDetails(listing)}
        aria-label={`${t('actions.details')} ${title}`}
        data-testid={`view-resource-${listing.id}-button`}
      />
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/10 bg-primary/5 text-primary">
            <TypeIcon className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className={cn('min-w-0', !isAgent && !isDirectlyUsableSystemCapability && 'pr-10')}>
            <h3
              className={cn(
                'truncate font-semibold text-text-primary',
                compact ? 'text-sm' : 'text-base'
              )}
            >
              {title}
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Badge variant="info">{t(`filters.${listing.resource_type}`)}</Badge>
              {listing.current_version?.version && (
                <span className="text-xs text-text-muted">v{listing.current_version.version}</span>
              )}
            </div>
          </div>
        </div>
        {isDirectlyUsableSystemCapability ? (
          <div
            className="absolute right-4 top-4 z-20 flex h-9 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-xs text-text-secondary"
            title={t('actions.system_available')}
            data-testid={`system-resource-${listing.id}-available`}
          >
            <Check className="h-4 w-4" aria-hidden />
            <span>{t('actions.system_available')}</span>
          </div>
        ) : (
          <Button
            type="button"
            variant={isAgent && !installDisabled ? 'primary' : 'secondary'}
            size="sm"
            className={cn(
              'absolute right-4 top-4 z-20 shrink-0',
              isAgent
                ? 'h-8 px-2.5 text-xs opacity-100 transition-opacity md:pointer-events-none md:opacity-0 md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100 md:group-hover:pointer-events-auto md:group-hover:opacity-100'
                : 'h-11 w-11 border-0 bg-muted p-0 text-text-primary hover:bg-muted/80 md:h-9 md:w-9'
            )}
            disabled={installDisabled}
            onClick={() => onInstall(listing)}
            aria-label={`${actionLabel} ${title}`}
            data-testid={`install-resource-${listing.id}-button`}
          >
            {isAgent ? (
              actionLabel
            ) : isInstalling ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : listing.is_installed && isPersonalTarget ? (
              <Check className="h-4 w-4" aria-hidden />
            ) : (
              <Plus className="h-4 w-4" aria-hidden />
            )}
          </Button>
        )}
      </div>

      <p className="line-clamp-2 min-h-10 text-sm leading-5 text-text-secondary">
        {listing.description || listing.name}
      </p>

      {listing.tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {listing.tags.slice(0, compact ? 2 : 3).map(tag => (
            <Badge key={tag} variant="secondary">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      <ResourceCardFooter
        owner={publisher}
        updatedAt={listing.updated_at}
        testId={`resource-listing-footer-${listing.id}`}
      />
    </Card>
  )
}
