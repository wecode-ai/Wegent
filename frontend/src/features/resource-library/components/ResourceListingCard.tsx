// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react'
import { format } from 'date-fns'
import { ChatBubbleLeftEllipsisIcon, CodeBracketIcon } from '@heroicons/react/24/outline'
import {
  Bot,
  BrainCircuit,
  Check,
  Database,
  Loader2,
  Plus,
  Server,
  Sparkles,
  SquareTerminal,
} from 'lucide-react'

import {
  getResourceCardActionsClassName,
  getResourceCardClassName,
} from '@/components/common/resourceCardLayout'
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
  presentation?: 'discovery' | 'management'
  managementAction?: ReactNode
  managementFooterAction?: ReactNode
}

const typeIcons = {
  agent: Bot,
  skill: Sparkles,
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
  managementAction,
  managementFooterAction,
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
  const isOfficial = listing.publisher_user_id === 0
  const isOfficialAgent = isAgent && isOfficial
  const isManagementPresentation = presentation === 'management'
  const isFloatingAgentAction = isAgent && isPersonalTarget && !isManagementPresentation
  const isManagementAgentAction = isAgent && isManagementPresentation
  const isTopRightSkillAction =
    listing.resource_type === 'skill' && isPersonalTarget && !isManagementPresentation
  const isTopRightAction = isFloatingAgentAction || isTopRightSkillAction
  const updatedDate = new Date(listing.updated_at)
  const hasUpdatedDate = !Number.isNaN(updatedDate.getTime())
  const updatedDateLabel = hasUpdatedDate ? format(updatedDate, 'yyyy-MM-dd') : null
  const updatedDateTitle = hasUpdatedDate ? format(updatedDate, 'yyyy-MM-dd HH:mm:ss') : undefined
  const showInstallCount = !isOfficialAgent && listing.install_count > 0
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
  const showManagementHeaderAction = isManagementPresentation && Boolean(managementAction)

  return (
    <Card
      className={cn(
        isManagementPresentation
          ? getResourceCardClassName(true)
          : 'flex flex-col overflow-hidden rounded-xl border-border bg-surface px-4 pt-4 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md',
        'group relative',
        isManagementPresentation
          ? 'gap-3'
          : isAgent
            ? 'h-full gap-2.5 pb-3'
            : 'min-h-[190px] gap-3 pb-4'
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
      <div className={cn('flex min-w-0 items-start gap-3', isTopRightSkillAction && 'pr-16')}>
        <div
          className={cn(
            'flex shrink-0 items-center justify-center border border-primary/10 bg-primary/5 text-primary',
            isAgent ? 'h-10 w-10 rounded-lg' : 'h-11 w-11 rounded-xl'
          )}
        >
          <TypeIcon className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3
            className={cn(
              'truncate font-semibold text-text-primary',
              compact ? 'text-sm' : 'text-base'
            )}
          >
            {title}
          </h3>
          {(listing.current_version?.version || isOfficial) && (
            <div className="mt-1 flex min-w-0 items-center gap-1.5">
              {listing.current_version?.version && (
                <span className="text-xs text-text-muted">v{listing.current_version.version}</span>
              )}
              {isOfficial && (
                <Badge variant="success" size="sm">
                  {t('fields.official_badge')}
                </Badge>
              )}
            </div>
          )}
        </div>
        {showManagementHeaderAction && (
          <div
            className="relative z-20 flex shrink-0 items-center gap-1.5"
            data-testid={`resource-listing-management-actions-${listing.id}`}
          >
            {managementAction}
          </div>
        )}
      </div>

      <p
        className={cn('line-clamp-2 text-sm leading-5 text-text-secondary', !isAgent && 'min-h-10')}
      >
        {listing.description || listing.name}
      </p>

      {isManagementAgentAction && (
        <div
          className={cn('relative z-20 min-w-0', getResourceCardActionsClassName(true))}
          data-testid={`resource-listing-primary-action-${listing.id}`}
        >
          {actionButton}
        </div>
      )}

      {isManagementPresentation && managementFooterAction && (
        <div
          className={cn('relative z-20 min-w-0', getResourceCardActionsClassName(true))}
          data-testid={`resource-listing-footer-action-${listing.id}`}
        >
          {managementFooterAction}
        </div>
      )}

      {!isManagementPresentation && (
        <div
          className={cn(
            'mt-auto flex min-w-0 items-center justify-between gap-3 border-t border-border',
            isAgent ? 'pt-2' : 'pt-3'
          )}
          data-testid={`resource-listing-footer-${listing.id}`}
        >
          <div className="flex min-w-0 items-center gap-1 text-xs text-text-muted">
            {publisher && <span className="min-w-0 truncate">{publisher}</span>}
            {updatedDateLabel && (
              <>
                {publisher && <span className="shrink-0">·</span>}
                <time className="shrink-0" dateTime={listing.updated_at} title={updatedDateTitle}>
                  {updatedDateLabel}
                </time>
              </>
            )}
            {showInstallCount && (
              <>
                {(publisher || updatedDateLabel) && <span className="shrink-0">·</span>}
                <span className="shrink-0">
                  {formatInstallCount(listing.install_count)} {t('fields.people_added')}
                </span>
              </>
            )}
          </div>
          {!isTopRightAction && actionButton}
        </div>
      )}
    </Card>
  )
}
