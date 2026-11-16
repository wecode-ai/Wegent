import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { PluginMarketplaceItem } from '@/types/api'
import type { MarketplaceCategorySection } from '../marketplaceCategorySections'
import type { PluginMarketplaceRowAction, PluginMarketplaceRowLabels } from './PluginMarketplaceRow'
import { MarketplaceCardGrid } from './MarketplaceCardGrid'

export function CategoryBrowseDialog({
  section,
  isLoggedIn,
  isReconciling,
  installingMarketplacePluginIds,
  isLocallyUninstalling,
  allowPendingRetry,
  showPendingAsSyncing,
  rowLabels,
  onClose,
  onAction,
}: {
  section: MarketplaceCategorySection
  isLoggedIn: boolean
  isReconciling: boolean
  installingMarketplacePluginIds: Set<string | number>
  isLocallyUninstalling: (item: PluginMarketplaceItem) => boolean
  allowPendingRetry: boolean
  showPendingAsSyncing?: boolean
  rowLabels: PluginMarketplaceRowLabels
  onClose: () => void
  onAction: (action: PluginMarketplaceRowAction, item: PluginMarketplaceItem) => void
}) {
  const { t } = useTranslation('common')
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frameId = window.requestAnimationFrame(() => dialogRef.current?.focus())
    return () => {
      window.cancelAnimationFrame(frameId)
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [])

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Portaled menus own their keyboard and focus scope, including Escape.
    if (!event.currentTarget.contains(event.target as Node)) return
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []
    )
    if (focusable.length === 0) {
      event.preventDefault()
      dialogRef.current?.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className="plugin-dialog-overlay fixed inset-0 z-50 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugins-category-browse-title"
        tabIndex={-1}
        data-testid="plugins-category-browse-dialog"
        className="plugin-dialog-surface flex max-h-[88vh] w-full max-w-[920px] flex-col overflow-hidden"
        onClick={event => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="plugin-dialog-divider flex shrink-0 items-start justify-between gap-6 border-b px-6 py-5">
          <div className="min-w-0">
            <h2 id="plugins-category-browse-title" className="heading-subsection text-text-primary">
              {section.title}
            </h2>
            <p className="mt-1 text-sm leading-5 text-text-secondary">
              {t('workbench.plugins_category_browse_count', '{{count}} 个插件', {
                count: section.items.length,
              })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            data-testid="plugins-category-browse-close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text-primary focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/20"
            aria-label={t('common.close', '关闭')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div
          data-plugin-market-scroll-region=""
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5"
        >
          <MarketplaceCardGrid
            items={section.items}
            isLoggedIn={isLoggedIn}
            isReconciling={isReconciling}
            installingMarketplacePluginIds={installingMarketplacePluginIds}
            isLocallyUninstalling={isLocallyUninstalling}
            allowPendingRetry={allowPendingRetry}
            showPendingAsSyncing={showPendingAsSyncing}
            labels={rowLabels}
            onAction={onAction}
          />
        </div>
      </div>
    </div>
  )
}
