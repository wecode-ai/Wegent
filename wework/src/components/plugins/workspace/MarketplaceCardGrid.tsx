import { useMediaQuery } from '@wegent/collaboration/media-query'
import { memo, useCallback, useRef } from 'react'
import { useElementGeometry } from '@wegent/collaboration/dom-events'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { PluginMarketplaceItem } from '@/types/api'
import { PluginMarketplaceRow } from './PluginMarketplaceRow'
import type { PluginMarketplaceRowProps } from './pluginMarketplaceRowEquality'

type GridProps = Omit<
  PluginMarketplaceRowProps,
  'item' | 'isInstalling' | 'isUninstalling' | 'needsAccountInstall'
> & {
  items: PluginMarketplaceItem[]
  installingMarketplacePluginIds: Set<string | number>
  isLocallyUninstalling: (item: PluginMarketplaceItem) => boolean
  accountInstallState?: (item: PluginMarketplaceItem) => 'needed' | 'installing' | undefined
}

const GRID_BREAKPOINT_PX = 1050
const ROW_ESTIMATE_PX = 88

export function MarketplaceCardGrid(props: GridProps) {
  if (props.items.length > 40) return <VirtualizedMarketplaceCardGrid {...props} />
  return (
    <div className="plugin-market-card-grid">
      {props.items.map(item => renderCard(props, item))}
    </div>
  )
}

function renderCard(props: GridProps, item: PluginMarketplaceItem) {
  const accountInstallState = props.accountInstallState?.(item)
  return (
    <PluginMarketplaceRow
      key={item.id}
      item={item}
      isLoggedIn={props.isLoggedIn}
      isReconciling={props.isReconciling}
      isInstalling={
        props.installingMarketplacePluginIds.has(item.id) || accountInstallState === 'installing'
      }
      isUninstalling={props.isLocallyUninstalling(item)}
      needsAccountInstall={accountInstallState !== undefined}
      allowPendingRetry={props.allowPendingRetry}
      showPendingAsSyncing={props.showPendingAsSyncing}
      labels={props.labels}
      onAction={props.onAction}
    />
  )
}

// Range updates keep existing rows mounted. Resolve inventory-dependent state
// only for new rows, or when their catalog/operation inputs actually change.
const MarketplaceRowCards = memo(function MarketplaceRowCards({
  grid,
  index,
  columnCount,
}: {
  grid: GridProps
  index: number
  columnCount: number
}) {
  return (
    <>
      {grid.items
        .slice(index * columnCount, (index + 1) * columnCount)
        .map(item => renderCard(grid, item))}
    </>
  )
})

function VirtualizedMarketplaceCardGrid(props: GridProps) {
  const { items } = props
  const listRef = useRef<HTMLDivElement>(null)
  const scrollElement = () =>
    listRef.current?.closest<HTMLElement>('[data-plugin-market-scroll-region]') ?? null
  const columnCount = useMediaQuery(`(max-width: ${GRID_BREAKPOINT_PX}px)`) ? 1 : 2
  const viewportRef = useRef<HTMLElement>(null)
  const bindList = useCallback((list: HTMLDivElement | null) => {
    listRef.current = list
    viewportRef.current = list?.closest<HTMLElement>('[data-plugin-market-scroll-region]') ?? null
  }, [])
  const geometry = useElementGeometry([listRef, viewportRef])
  const listBounds = geometry?.elements[0]
  const viewportBounds = geometry?.elements[1]
  const scrollMargin =
    listBounds && viewportBounds
      ? Math.round(listBounds.top - viewportBounds.top + (viewportRef.current?.scrollTop ?? 0))
      : 0
  const getItemKey = useCallback(
    (index: number) => `${columnCount}:${items[index * columnCount].id}`,
    [columnCount, items]
  )
  // Headers, installed strips, and dialog padding live before the grid. Keep
  // measurements in the viewport's coordinate system without a second scroller.
  const virtualizer = useVirtualizer({
    count: Math.ceil(items.length / columnCount),
    getScrollElement: scrollElement,
    estimateSize: () => ROW_ESTIMATE_PX,
    getItemKey,
    scrollMargin,
    gap: 8,
    overscan: 3,
    useFlushSync: false,
    useAnimationFrameWithResizeObserver: true,
  })
  return (
    <div ref={bindList} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map(row => (
        <div
          key={row.key}
          ref={virtualizer.measureElement}
          data-index={row.index}
          className="plugin-market-card-grid absolute left-0 top-0 w-full"
          style={{ transform: `translateY(${row.start - scrollMargin}px)` }}
        >
          <MarketplaceRowCards grid={props} index={row.index} columnCount={columnCount} />
        </div>
      ))}
    </div>
  )
}
