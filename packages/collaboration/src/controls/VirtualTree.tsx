import {
  Tree,
  TreeItem,
  TreeItemIndicator,
  TreeItemLabel,
  visibleTreeRows,
  type TreeItemData,
  type TreeItemState,
} from '@ui-sdk/react/tree'
import { ChevronRight } from 'lucide-react'
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

export interface VirtualTreeProps extends Omit<
  ComponentProps<typeof Tree<'single'>>,
  'items' | 'paths' | 'children' | 'expanded' | 'onExpandedChange'
> {
  'data-testid'?: string
  items: TreeItemData[]
  expanded: string[]
  onExpandedChange: ComponentProps<typeof Tree<'single'>>['onExpandedChange']
  viewportClassName?: string
  rowHeight?: number
  scrollToValue?: string | null
  scrollAlign?: 'center' | 'nearest'
  visible?: boolean
  renderLabel?(item: TreeItemData, state: TreeItemState): ReactNode
  itemProps?(
    item: TreeItemData
  ): Omit<ComponentProps<typeof TreeItem>, 'value' | 'children' | 'style' | 'className'>
}

export function VirtualTree({
  items,
  expanded,
  onExpandedChange,
  viewportClassName,
  rowHeight = 28,
  scrollToValue,
  scrollAlign = 'nearest',
  visible = true,
  renderLabel,
  itemProps,
  onHighlight,
  className,
  style,
  ...props
}: VirtualTreeProps) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  const [height, setHeight] = useState(280)
  const [position, setPosition] = useState({ offset: 0, target: '' })
  const rows = useMemo(() => visibleTreeRows(items, expanded), [items, expanded])

  useLayoutEffect(() => {
    if (!viewport) return
    const measure = () => {
      if (viewport.clientHeight > 0) setHeight(viewport.clientHeight)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [viewport])

  const targetIndex =
    visible && scrollToValue ? rows.findIndex(row => row.item.value === scrollToValue) : -1
  const target = targetIndex >= 0 ? `${scrollToValue}:${targetIndex}:${scrollAlign}:${height}` : ''
  const top = targetIndex * rowHeight
  const desiredOffset =
    scrollAlign === 'center'
      ? Math.max(0, top - (height - rowHeight) / 2)
      : top < position.offset
        ? top
        : top + rowHeight > position.offset + height
          ? top + rowHeight - height
          : position.offset
  const scrollTop =
    target && target !== position.target
      ? Math.max(0, Math.min(desiredOffset, rows.length * rowHeight - height))
      : position.offset
  const requestedOffset = target && target !== position.target ? scrollTop : null
  const attachViewport = useCallback(
    (node: HTMLDivElement | null) => {
      setViewport(node)
      if (node && requestedOffset !== null)
        node.scrollTo({ top: requestedOffset, behavior: 'instant' })
    },
    [requestedOffset]
  )

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 4)
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / rowHeight) + 4)
  return (
    <div
      ref={attachViewport}
      data-testid={props['data-testid'] ? `${props['data-testid']}-viewport` : undefined}
      className={cn('relative min-h-0 min-w-0 overflow-auto', viewportClassName)}
      onScroll={event => setPosition({ offset: event.currentTarget.scrollTop, target })}
    >
      <Tree
        {...props}
        items={items}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
        className={state =>
          cn(
            'relative min-w-full outline-none',
            typeof className === 'function' ? className(state) : className
          )
        }
        style={state => ({
          ...(typeof style === 'function' ? style(state) : style),
          height: rows.length * rowHeight,
        })}
        onHighlight={(value, details) => {
          onHighlight?.(value, details)
          if (!viewport) return
          const top = details.index * rowHeight
          const offset =
            top < viewport.scrollTop
              ? top
              : top + rowHeight > viewport.scrollTop + height
                ? top + rowHeight - height
                : viewport.scrollTop
          viewport.scrollTo({ top: offset, behavior: 'instant' })
          setPosition({ offset, target })
        }}
      >
        {rows.slice(start, end).map(({ item, index, level }) => {
          const extras = itemProps?.(item)
          return (
            <TreeItem
              {...extras}
              key={item.value}
              value={item.value}
              label={item.label}
              branch={Boolean(item.children)}
              disabled={item.disabled}
              render={extras?.render ?? <button type="button" />}
              aria-label={item.label}
              data-type="item"
              data-item-path={item.value}
              className="absolute left-0 flex w-full items-center gap-1 rounded-md pr-2 text-left text-sm text-text-secondary outline-none hover:bg-muted data-[selected]:bg-muted data-[selected]:text-text-primary keyboard:focus-visible:ring-1 keyboard:focus-visible:ring-inset keyboard:focus-visible:ring-focus/40"
              style={{
                top: index * rowHeight,
                height: rowHeight,
                paddingLeft: 4 + (level - 1) * 14,
              }}
            >
              {state => (
                <TreeItemLabel className="flex min-w-0 flex-1 items-center gap-1.5">
                  {state.branch ? (
                    <TreeItemIndicator className="flex h-5 w-5 shrink-0 items-center justify-center">
                      <ChevronRight
                        className={cn(
                          'h-3.5 w-3.5 transition-transform',
                          state.expanded && 'rotate-90'
                        )}
                        aria-hidden="true"
                      />
                    </TreeItemIndicator>
                  ) : (
                    <span className="w-5 shrink-0" />
                  )}
                  {renderLabel ? (
                    renderLabel(item, state)
                  ) : (
                    <span className="truncate">{item.label}</span>
                  )}
                </TreeItemLabel>
              )}
            </TreeItem>
          )
        })}
      </Tree>
    </div>
  )
}
