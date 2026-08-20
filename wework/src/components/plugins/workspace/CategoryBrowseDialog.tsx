import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { PluginMarketplaceItem } from '@/types/api'
import type { MarketplaceCategorySection } from '../marketplaceCategorySections'
import {
  PluginMarketplaceRow,
  type PluginMarketplaceRowAction,
  type PluginMarketplaceRowLabels,
} from './PluginMarketplaceRow'

const CATEGORY_ROW_ESTIMATE_PX = 78
const CATEGORY_GRID_BREAKPOINT_PX = 1050

export function CategoryBrowseDialog({
  section,
  isLoggedIn,
  installingMarketplacePluginIds,
  uninstallingPluginIds,
  allowPendingRetry,
  showPendingAsSyncing,
  rowLabels,
  onClose,
  onAction,
}: {
  section: MarketplaceCategorySection
  isLoggedIn: boolean
  installingMarketplacePluginIds: Set<string | number>
  uninstallingPluginIds: Set<string | number>
  allowPendingRetry: boolean
  showPendingAsSyncing?: boolean
  rowLabels: PluginMarketplaceRowLabels
  onClose: () => void
  onAction: (action: PluginMarketplaceRowAction, item: PluginMarketplaceItem) => void
}) {
  const { t } = useTranslation('common')
  const dialogRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [columnCount, setColumnCount] = useState(() =>
    typeof window === 'undefined' || window.innerWidth > CATEGORY_GRID_BREAKPOINT_PX ? 2 : 1
  )

  useEffect(() => {
    const media = window.matchMedia(`(max-width: ${CATEGORY_GRID_BREAKPOINT_PX}px)`)
    const syncColumns = () => setColumnCount(media.matches ? 1 : 2)
    syncColumns()
    media.addEventListener('change', syncColumns)
    return () => media.removeEventListener('change', syncColumns)
  }, [])

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frameId = window.requestAnimationFrame(() => dialogRef.current?.focus())
    return () => {
      window.cancelAnimationFrame(frameId)
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [])

  const rowCount = Math.max(1, Math.ceil(section.items.length / columnCount))
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => listRef.current,
    estimateSize: () => CATEGORY_ROW_ESTIMATE_PX,
    overscan: 8,
    observeElementRect: (instance, callback) => {
      const element = instance.scrollElement
      if (!element) return
      const emit = () => {
        const rect = element.getBoundingClientRect()
        callback({
          width: Math.max(rect.width, 720),
          height: Math.max(rect.height, 560),
        })
      }
      emit()
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(emit)
      observer?.observe(element)
      window.addEventListener('resize', emit)
      return () => {
        observer?.disconnect()
        window.removeEventListener('resize', emit)
      }
    },
  })

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
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

  const virtualRows = virtualizer.getVirtualItems()
  const rowItems = useMemo(
    () =>
      virtualRows.map(row => ({
        row,
        items: section.items.slice(row.index * columnCount, row.index * columnCount + columnCount),
      })),
    [columnCount, section.items, virtualRows]
  )

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
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20"
            aria-label={t('common.close', '关闭')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {rowItems.map(({ row, items }) => (
              <div
                key={row.key}
                className="plugin-market-card-grid absolute left-0 top-0 w-full"
                style={{
                  transform: `translateY(${row.start}px)`,
                }}
              >
                {items.map(item => (
                  <PluginMarketplaceRow
                    key={item.id}
                    item={item}
                    isLoggedIn={isLoggedIn}
                    isInstalling={installingMarketplacePluginIds.has(item.id)}
                    isUninstalling={uninstallingPluginIds.has(item.installedPluginId ?? item.id)}
                    allowPendingRetry={allowPendingRetry}
                    showPendingAsSyncing={showPendingAsSyncing}
                    labels={rowLabels}
                    onAction={onAction}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
