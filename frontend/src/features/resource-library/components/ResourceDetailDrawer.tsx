// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Plus, Sparkles } from 'lucide-react'

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
import type { ResourceLibraryListing } from '../types'

interface ResourceDetailDrawerProps {
  listing: ResourceLibraryListing | null
  open: boolean
  isLoading?: boolean
  isInstalling?: boolean
  onOpenChange: (open: boolean) => void
  onInstall: (listing: ResourceLibraryListing) => void
  targetNamespace?: string
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
}: ResourceDetailDrawerProps) {
  const { t } = useTranslation('resource-library')
  const title = listing ? getListingTitle(listing) : ''
  const isAgent = listing?.resource_type === 'agent'
  const isDirectlyUsableSystemCapability =
    !!listing &&
    ['model', 'shell', 'retriever'].includes(listing.resource_type) &&
    listing.publisher_user_id === 0
  const isPersonalTarget = targetNamespace === 'default'
  const installDisabled =
    !listing || isLoading || (!isAgent && listing.is_installed && isPersonalTarget) || isInstalling
  const actionLabel = isAgent
    ? isPersonalTarget
      ? t('actions.use')
      : t('actions.add')
    : listing?.is_installed && isPersonalTarget
      ? t('actions.added')
      : t('actions.add')
  const ActionIcon = isAgent && isPersonalTarget ? Sparkles : Plus
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
          <div className="min-w-0 pr-8">
            <DialogTitle className="truncate text-xl">{title || t('actions.details')}</DialogTitle>
            {listing && (
              <DialogDescription className="mt-2 flex flex-wrap items-center gap-2">
                <Badge variant="info">{t(`filters.${listing.resource_type}`)}</Badge>
                {listing.current_version?.version && (
                  <span className="text-xs text-text-muted">
                    v{listing.current_version.version}
                  </span>
                )}
                {isDirectlyUsableSystemCapability && (
                  <Badge variant="secondary">{t('actions.system_available')}</Badge>
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

              {listing.tags.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {listing.tags.map(tag => (
                    <Badge key={tag} variant="secondary">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>

        {!isDirectlyUsableSystemCapability && (
          <DialogFooter className="border-t border-border px-6 py-4">
            <Button
              type="button"
              variant={installDisabled ? 'secondary' : 'primary'}
              className="h-11 min-w-[44px]"
              disabled={installDisabled}
              onClick={() => listing && onInstall(listing)}
              aria-label={`${actionLabel} ${title}`}
              data-testid="resource-detail-install-button"
            >
              <ActionIcon className="h-4 w-4" aria-hidden="true" />
              {actionLabel}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
