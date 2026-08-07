// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ChatBubbleLeftEllipsisIcon, CodeBracketIcon } from '@heroicons/react/24/outline'
import { ExternalLink, MessageSquareText, Plus } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { ResourceLibraryListing } from '../types'

interface ResourceDetailDrawerProps {
  listing: ResourceLibraryListing | null
  open: boolean
  isLoading?: boolean
  isInstalling?: boolean
  onOpenChange: (open: boolean) => void
  onInstall: (listing: ResourceLibraryListing) => void
  targetNamespace?: string
  tagLabels?: Record<string, string>
}

function getListingTitle(listing: ResourceLibraryListing) {
  return listing.display_name || listing.name
}

export function ResourceDetailDrawer({
  listing,
  open,
  isLoading = false,
  isInstalling = false,
  onOpenChange,
  onInstall,
  targetNamespace = 'default',
  tagLabels = {},
}: ResourceDetailDrawerProps) {
  const { t } = useTranslation('resource-library')
  const title = listing ? getListingTitle(listing) : ''
  const isAgent = listing?.resource_type === 'agent'
  const isSkill = listing?.resource_type === 'skill'
  const isCodeOnlyAgent =
    isAgent && listing.bind_modes.length === 1 && listing.bind_modes.includes('code')
  const isDirectlyUsableSystemCapability =
    !!listing &&
    ['model', 'shell', 'retriever'].includes(listing.resource_type) &&
    listing.publisher_user_id === 0
  const isPersonalTarget = targetNamespace === 'default'
  const installDisabled =
    !listing ||
    (!isAgent && isLoading) ||
    (!isAgent && listing.is_installed && isPersonalTarget) ||
    isInstalling
  const actionLabel = isAgent
    ? isPersonalTarget
      ? t(isCodeOnlyAgent ? 'actions.open_code' : 'actions.open_chat')
      : t('actions.add')
    : listing?.is_installed && isPersonalTarget
      ? t('actions.added')
      : t(isSkill ? 'actions.install' : 'actions.add')
  const ActionIcon =
    isAgent && isPersonalTarget
      ? isCodeOnlyAgent
        ? CodeBracketIcon
        : ChatBubbleLeftEllipsisIcon
      : Plus
  const publisher = listing
    ? listing.publisher_user_id === 0
      ? t('fields.official_publisher')
      : listing.publisher_user_name || `#${listing.publisher_user_id}`
    : ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] w-[calc(100%-2rem)] max-w-2xl flex-col gap-0 overflow-hidden rounded-2xl p-0"
        data-testid="resource-detail-dialog"
      >
        <DialogHeader className="border-b border-border px-6 py-5 text-left">
          <div className={cn('min-w-0 pr-8', !isDirectlyUsableSystemCapability && 'md:pr-44')}>
            <DialogTitle className="truncate text-xl">{title || t('actions.details')}</DialogTitle>
            {listing && (
              <DialogDescription className="mt-2 flex flex-wrap items-center gap-2">
                <Badge variant="info">{t(`filters.${listing.resource_type}`)}</Badge>
                {listing.current_version?.version && (
                  <span className="text-xs text-text-muted">
                    v{listing.current_version.version}
                  </span>
                )}
                <span className="text-xs text-text-muted">
                  {t('fields.publisher')} · {publisher}
                </span>
              </DialogDescription>
            )}
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-5 w-1/2" />
            </div>
          ) : listing ? (
            <div className="space-y-5">
              <p className="text-sm leading-6 text-text-secondary">
                {listing.description || listing.name}
              </p>

              {isAgent && Boolean(listing.example_conversations?.length) && (
                <div className="rounded-xl border border-border bg-base p-4">
                  <div className="flex items-start gap-3">
                    <MessageSquareText
                      className="mt-0.5 h-5 w-5 shrink-0 text-primary"
                      aria-hidden
                    />
                    <div>
                      <p className="text-sm font-medium text-text-primary">
                        {t('fields.example_conversation')}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-text-muted">
                        {t('fields.example_conversation_description')}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {listing.example_conversations?.map((example, index) => (
                      <Button
                        key={`${example.url}-${index}`}
                        type="button"
                        variant="outline"
                        className="h-auto min-h-10 justify-between whitespace-normal py-2 text-left"
                        asChild
                      >
                        <a
                          href={example.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid={`resource-detail-example-conversation-${index}`}
                        >
                          <span>{example.title}</span>
                          <ExternalLink className="h-4 w-4 shrink-0" aria-hidden />
                        </a>
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {(listing.tags.length > 0 || Boolean(listing.feature_tags?.length)) && (
                <div className="flex flex-wrap gap-2">
                  {(listing.tags.length > 0 ? listing.tags : listing.feature_tags || []).map(
                    tag => {
                      const usesFeatureTagFallback = listing.tags.length === 0
                      return (
                        <Badge
                          key={tag}
                          variant="secondary"
                          title={
                            usesFeatureTagFallback
                              ? t('marketplace_tags.skill_keywords_fallback')
                              : t('marketplace_tags.field_label')
                          }
                        >
                          {usesFeatureTagFallback ? tag : tagLabels[tag] || tag}
                        </Badge>
                      )
                    }
                  )}
                </div>
              )}
            </div>
          ) : null}
        </div>

        {!isDirectlyUsableSystemCapability && (
          <DialogFooter
            className="border-t border-border px-6 py-4 md:absolute md:right-12 md:top-4 md:z-10 md:border-0 md:p-0"
            data-testid="resource-detail-actions"
          >
            <Button
              type="button"
              variant={installDisabled ? 'secondary' : 'primary'}
              className="h-11 w-full min-w-[44px] md:h-9 md:w-auto"
              disabled={installDisabled}
              onClick={() => listing && onInstall(listing)}
              aria-label={`${actionLabel} ${title}`}
              data-testid="resource-detail-install-button"
            >
              {!isSkill && <ActionIcon className="h-4 w-4" aria-hidden="true" />}
              {actionLabel}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
