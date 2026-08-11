// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react'
import { ChatBubbleLeftEllipsisIcon, CodeBracketIcon } from '@heroicons/react/24/outline'
import { Check, Loader2, Plus } from 'lucide-react'

import {
  getResourceCardActionsClassName,
  getResourceCardClassName,
} from '@/components/common/resourceCardLayout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { ResourceLibraryListing } from '../types'
import { ResourceIcon } from './ResourceIcon'

interface ResourceListingCardProps {
  listing: ResourceLibraryListing
  isInstalling?: boolean
  onInstall: (listing: ResourceLibraryListing) => void
  onViewDetails: (listing: ResourceLibraryListing) => void
  targetNamespace?: string
  compact?: boolean
  presentation?: 'discovery' | 'management'
  managementFooterAction?: ReactNode
  tagLabels?: Record<string, string>
}

function getListingTitle(listing: ResourceLibraryListing) {
  return listing.display_name || listing.name
}

function getPublisher(listing: ResourceLibraryListing, officialPublisher: string) {
  if (listing.publisher_user_id === 0) return officialPublisher
  return listing.publisher_user_name?.trim() || listing.publisher_namespace?.trim() || null
}

function formatInstallCount(count: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: count >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(count)
}

export function ResourceListingCard({
  listing,
  isInstalling = false,
  onInstall,
  onViewDetails,
  targetNamespace = 'default',
  compact = false,
  presentation = 'discovery',
  managementFooterAction,
  tagLabels = {},
}: ResourceListingCardProps) {
  const { t } = useTranslation('resource-library')
  const title = getListingTitle(listing)
  const isAgent = listing.resource_type === 'agent'
  const isDirectlyUsableSystemCapability =
    ['model', 'shell', 'retriever'].includes(listing.resource_type) &&
    listing.publisher_user_id === 0
  const isPersonalTarget = targetNamespace === 'default'
  const isCodeOnlyAgent =
    isAgent && listing.bind_modes.length === 1 && listing.bind_modes.includes('code')
  const publisher = getPublisher(listing, t('fields.official_publisher'))
  const usesFeatureTagFallback =
    listing.resource_type === 'skill' &&
    listing.tags.length === 0 &&
    Boolean(listing.feature_tags?.length)
  const displayedTags = usesFeatureTagFallback ? listing.feature_tags || [] : listing.tags
  const isManagementPresentation = presentation === 'management'
  const isFloatingAgentAction = isAgent && isPersonalTarget && !isManagementPresentation
  const isManagementAgentAction = isAgent && isManagementPresentation
  const isTopRightSkillAction =
    listing.resource_type === 'skill' && isPersonalTarget && !isManagementPresentation
  const isTopRightAction = isFloatingAgentAction || isTopRightSkillAction
  const showInstallCount = listing.install_count > 0
  const installDisabled = (!isAgent && listing.is_installed && isPersonalTarget) || isInstalling
  const actionLabel = isAgent
    ? isPersonalTarget
      ? t(isCodeOnlyAgent ? 'actions.open_code' : 'actions.open_chat')
      : t('actions.add')
    : listing.is_installed && isPersonalTarget
      ? t('actions.added')
      : t('actions.add')
  const showAction = !isDirectlyUsableSystemCapability && (!isManagementPresentation || isAgent)
  const actionButton = showAction && (
    <Button
      type="button"
      variant={
        isFloatingAgentAction ? 'primary' : isManagementPresentation ? 'outline' : 'secondary'
      }
      size="sm"
      className={cn(
        'relative z-20 h-9 shrink-0 px-3 text-xs',
        isTopRightSkillAction && 'absolute right-3 top-3 h-11 w-11 px-0 md:h-8 md:w-8',
        isTopRightSkillAction &&
          !listing.is_installed &&
          'border-primary/20 bg-primary/[0.04] text-primary shadow-sm transition-[background-color,border-color,box-shadow] duration-150 hover:border-primary/40 hover:bg-primary/[0.1] hover:shadow-md',
        isFloatingAgentAction &&
          'absolute right-3 top-3 h-11 min-w-[44px] px-2.5 shadow-sm transition-opacity md:h-7 md:min-w-0 md:pointer-events-none md:opacity-0 md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100 md:group-hover:pointer-events-auto md:group-hover:opacity-100',
        isManagementAgentAction &&
          'h-11 w-full gap-2 border-primary/[0.15] bg-primary/[0.08] px-3 text-xs text-primary hover:border-primary/20 hover:bg-primary/[0.15] md:h-8'
      )}
      disabled={installDisabled}
      onClick={() => onInstall(listing)}
      aria-label={`${actionLabel} ${title}`}
      title={isTopRightSkillAction ? actionLabel : undefined}
      data-testid={`install-resource-${listing.id}-button`}
    >
      {isInstalling ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : isManagementAgentAction ? (
        isCodeOnlyAgent ? (
          <CodeBracketIcon className="h-4 w-4" aria-hidden />
        ) : (
          <ChatBubbleLeftEllipsisIcon className="h-4 w-4" aria-hidden />
        )
      ) : isTopRightSkillAction ? (
        listing.is_installed ? (
          <Check className="h-4 w-4" aria-hidden />
        ) : (
          <Plus className="h-4 w-4" aria-hidden />
        )
      ) : !isAgent && listing.is_installed && isPersonalTarget ? (
        <Check className="h-4 w-4" aria-hidden />
      ) : null}
      {!isTopRightSkillAction && actionLabel}
    </Button>
  )
  return (
    <Card
      className={cn(
        isManagementPresentation
          ? getResourceCardClassName(true)
          : 'flex h-full flex-col overflow-hidden rounded-xl border-border bg-surface p-4 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md',
        'group relative gap-3'
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
      {isTopRightAction && actionButton}
      <div
        className={cn(
          'flex min-w-0 items-start gap-3',
          isTopRightSkillAction && 'pr-14',
          isFloatingAgentAction && 'pr-20'
        )}
      >
        <ResourceIcon
          resourceType={listing.resource_type}
          name={title}
          icon={listing.icon}
          marketplaceTags={listing.tags}
          size={isAgent ? 'sm' : 'md'}
        />
        <div className="min-w-0 flex-1">
          <h3
            className={cn(
              'truncate font-semibold text-text-primary',
              compact ? 'text-sm' : 'text-base'
            )}
          >
            {title}
          </h3>
          {publisher && <p className="mt-0.5 truncate text-xs text-text-muted">{publisher}</p>}
        </div>
      </div>

      <p className="line-clamp-2 min-h-10 text-sm leading-5 text-text-secondary">
        {listing.description || listing.name}
      </p>

      {displayedTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid={`resource-listing-tags-${listing.id}`}>
          {displayedTags.slice(0, 3).map(tag => (
            <Badge
              key={tag}
              variant="secondary"
              size="sm"
              title={
                usesFeatureTagFallback
                  ? t('marketplace_tags.skill_keywords_fallback')
                  : t('marketplace_tags.field_label')
              }
            >
              {usesFeatureTagFallback ? tag : tagLabels[tag] || tag}
            </Badge>
          ))}
        </div>
      )}

      {isManagementAgentAction && (
        <div
          className={cn('relative z-20 min-w-0', getResourceCardActionsClassName(true))}
          data-testid={`resource-listing-primary-action-${listing.id}`}
        >
          <div className="flex min-w-0 gap-2">
            <div className="min-w-0 flex-1">{actionButton}</div>
            {managementFooterAction}
          </div>
        </div>
      )}

      {isManagementPresentation && !isManagementAgentAction && managementFooterAction && (
        <div
          className={cn('relative z-20 min-w-0', getResourceCardActionsClassName(true))}
          data-testid={`resource-listing-footer-action-${listing.id}`}
        >
          {managementFooterAction}
        </div>
      )}

      {!isManagementPresentation &&
        (showInstallCount || (!isTopRightAction && Boolean(actionButton))) && (
          <div
            className="mt-auto flex min-w-0 items-center justify-between gap-3 pt-1"
            data-testid={`resource-listing-footer-${listing.id}`}
          >
            <span className="min-w-0 truncate text-xs text-text-muted">
              {showInstallCount
                ? `${formatInstallCount(listing.install_count)} ${t('fields.people_added')}`
                : null}
            </span>
            {!isTopRightAction && actionButton}
          </div>
        )}
    </Card>
  )
}
