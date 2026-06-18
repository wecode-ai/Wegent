// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { CheckCircle2, Lightbulb, ListChecks, UserPlus, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslation } from '@/hooks/useTranslation'
import { formatUTCDate } from '@/lib/utils'
import type { ResourceLibraryListing } from '../types'

interface ResourceDetailDrawerProps {
  listing: ResourceLibraryListing | null
  open: boolean
  isLoading?: boolean
  isInstalling?: boolean
  onOpenChange: (open: boolean) => void
  onInstall: (listing: ResourceLibraryListing) => void
}

function getListingTitle(listing: ResourceLibraryListing) {
  return listing.display_name || listing.name
}

function getStartSteps(t: (key: string) => string) {
  return [
    t('detail.start_steps.accept'),
    t('detail.start_steps.open_mine'),
    t('detail.start_steps.use'),
  ]
}

export function ResourceDetailDrawer({
  listing,
  open,
  isLoading = false,
  isInstalling = false,
  onOpenChange,
  onInstall,
}: ResourceDetailDrawerProps) {
  const { t } = useTranslation('resource-library')
  const title = listing ? getListingTitle(listing) : ''
  const installDisabled = !listing || listing.is_installed || isInstalling

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        className="max-h-[90vh] bg-base sm:inset-x-auto sm:inset-y-0 sm:left-auto sm:right-0 sm:mt-0 sm:h-screen sm:max-h-screen sm:w-[480px] sm:rounded-none sm:border-l"
        data-testid="resource-detail-drawer"
      >
        <DrawerHeader className="border-b border-border text-left">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <DrawerTitle className="truncate text-lg">
                {title || t('actions.details')}
              </DrawerTitle>
              {listing && (
                <DrawerDescription className="mt-2 flex flex-wrap gap-2">
                  <Badge variant="info">{t(`filters.${listing.resource_type}`)}</Badge>
                  {listing.current_version?.version && (
                    <span className="text-xs text-text-muted">
                      v{listing.current_version.version}
                    </span>
                  )}
                </DrawerDescription>
              )}
            </div>
            <DrawerClose asChild>
              <Button
                type="button"
                variant="ghost"
                className="h-11 min-w-[44px] px-3 lg:h-9"
                aria-label={t('actions.close')}
                data-testid="resource-detail-close-button"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DrawerClose>
          </div>
        </DrawerHeader>

        <div className="flex-1 overflow-y-auto px-4 py-5">
          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-5 w-1/2" />
            </div>
          ) : listing ? (
            <div className="space-y-5">
              <section className="rounded-lg border border-border bg-surface p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <Lightbulb className="h-4 w-4 text-primary" aria-hidden="true" />
                  {t('detail.sections.solves')}
                </div>
                <p className="mt-3 text-sm leading-6 text-text-secondary">
                  {listing.description || listing.name}
                </p>
              </section>

              <section className="rounded-lg border border-border bg-surface p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <ListChecks className="h-4 w-4 text-primary" aria-hidden="true" />
                  {t('detail.sections.get_started')}
                </div>
                <ol className="mt-3 space-y-3">
                  {getStartSteps(t).map((step, index) => (
                    <li key={step} className="flex gap-3 text-sm text-text-secondary">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                        {index + 1}
                      </span>
                      <span className="pt-0.5">{step}</span>
                    </li>
                  ))}
                </ol>
              </section>

              <section className="rounded-lg border border-border bg-surface p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <CheckCircle2 className="h-4 w-4 text-primary" aria-hidden="true" />
                  {t('detail.sections.examples')}
                </div>
                <div className="mt-3 rounded-lg border border-border bg-base px-3 py-2 text-sm text-text-secondary">
                  {t('detail.example_prompt', { title })}
                </div>
              </section>

              <section className="space-y-4 rounded-lg border border-border bg-surface p-4">
                <div className="text-sm font-semibold text-text-primary">
                  {t('detail.sections.resource_info')}
                </div>

                {listing.tags.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {listing.tags.map(tag => (
                      <Badge key={tag} variant="secondary">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}

                <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-text-muted">{t('fields.install_count')}</dt>
                    <dd className="mt-1 font-medium">{listing.install_count}</dd>
                  </div>
                  <div>
                    <dt className="text-text-muted">{t('fields.publisher')}</dt>
                    <dd className="mt-1 font-medium">#{listing.publisher_user_id}</dd>
                  </div>
                  <div>
                    <dt className="text-text-muted">{t('fields.updated_at')}</dt>
                    <dd className="mt-1 font-medium">{formatUTCDate(listing.updated_at)}</dd>
                  </div>
                  <div>
                    <dt className="text-text-muted">{t('fields.name')}</dt>
                    <dd className="mt-1 break-all font-medium">{listing.name}</dd>
                  </div>
                </dl>
              </section>
            </div>
          ) : null}
        </div>

        <DrawerFooter className="border-t border-border">
          <Button
            type="button"
            variant={listing?.is_installed ? 'secondary' : 'primary'}
            className="h-11 min-w-[44px]"
            disabled={installDisabled}
            onClick={() => listing && onInstall(listing)}
            aria-label={`${listing?.is_installed ? t('actions.installed') : t('actions.install')} ${title}`}
            data-testid="resource-detail-install-button"
          >
            <UserPlus className="h-4 w-4" aria-hidden="true" />
            {listing?.is_installed ? t('actions.installed') : t('actions.install')}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  )
}
