import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { PluginMarketplaceItem } from '@/types/api'
import { PluginMarketplaceRow } from './PluginMarketplaceRow'
import type { PluginMarketplaceRowProps } from './pluginMarketplaceRowEquality'

type GridProps = Omit<PluginMarketplaceRowProps, 'item' | 'isInstalling' | 'isUninstalling'> & {
  items: PluginMarketplaceItem[]
  installingMarketplacePluginIds: Set<string | number>
  isLocallyUninstalling: (item: PluginMarketplaceItem) => boolean
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
  return (
    <PluginMarketplaceRow
      key={item.id}
      item={item}
      isLoggedIn={props.isLoggedIn}
      isReconciling={props.isReconciling}
      isInstalling={props.installingMarketplacePluginIds.has(item.id)}
      isUninstalling={props.isLocallyUninstalling(item)}
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
  const [columnCount, setColumnCount] = useState(() =>
    window.innerWidth > GRID_BREAKPOINT_PX ? 2 : 1
  )
  const [scrollMargin, setScrollMargin] = useState(0)
  const getItemKey = useCallback(
    (index: number) => `${columnCount}:${items[index * columnCount].id}`,
    [columnCount, items]
  )
  useEffect(() => {
    const media = window.matchMedia(`(max-width: ${GRID_BREAKPOINT_PX}px)`)
    const update = () => setColumnCount(media.matches ? 1 : 2)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  // Headers, installed strips, and dialog padding live before the grid. Keep
  // measurements in the viewport's coordinate system without a second scroller.
  useLayoutEffect(() => {
    const list = listRef.current
    const viewport = list?.closest<HTMLElement>('[data-plugin-market-scroll-region]')
    if (!viewport || !list) return
    const measure = () => {
      const margin = list.getBoundingClientRect().top - viewport.getBoundingClientRect().top
      setScrollMargin(Math.round(margin + viewport.scrollTop))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(list)
    return () => observer.disconnect()
  }, [props])
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
    <div ref={listRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
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
