import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import {
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Check, Copy, Info, Minimize2 } from 'lucide-react'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import { createDevInstanceClipboard } from './appDevInstanceClipboard'
import { cn } from '@/lib/utils'
import { getWeworkDevInstanceInfo, getWeworkDevInstanceRows } from '@/lib/wework-dev-instance'
export function WeworkDevInstanceBadge() {
  const info = getWeworkDevInstanceInfo()
  const [clipboard] = useState(createDevInstanceClipboard)
  const copiedKey = useSyncExternalStore(
    clipboard.subscribe,
    clipboard.getSnapshot,
    clipboard.getSnapshot
  )
  const [collapsed, setCollapsed] = useState(true)
  const [position, setPosition] = useState<CSSProperties>()
  const [suppressClick, setSuppressClick] = useState(false)
  const [drag, setDrag] = useState<{ x: number; y: number; rect: DOMRect } | null>(null)
  useDOMEvent<PointerEvent>(
    'window',
    'pointermove',
    event => {
      if (!drag) return
      const deltaX = event.clientX - drag.x
      const deltaY = event.clientY - drag.y
      if (!suppressClick && Math.hypot(deltaX, deltaY) < 4) return
      setSuppressClick(true)
      setPosition({
        bottom: 'auto',
        right: 'auto',
        left: Math.min(
          Math.max(0, window.innerWidth - drag.rect.width),
          Math.max(0, drag.rect.left + deltaX)
        ),
        top: Math.min(
          Math.max(0, window.innerHeight - drag.rect.height),
          Math.max(0, drag.rect.top + deltaY)
        ),
      })
    },
    { enabled: Boolean(drag) }
  )
  useDOMEvent<PointerEvent>('window', 'pointerup', () => setDrag(null), { enabled: Boolean(drag) })
  useDOMEvent<PointerEvent>('window', 'pointercancel', () => setDrag(null), {
    enabled: Boolean(drag),
  })
  if (!info) return null

  const rows = getWeworkDevInstanceRows(info)
  const popoverAbove = typeof position?.top !== 'number' || position.top > window.innerHeight / 2
  const popoverAlignRight =
    typeof position?.left !== 'number' || position.left > window.innerWidth / 2
  const copyValue = clipboard.copy
  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    const root = event.currentTarget.parentElement
    if (!root) return
    setSuppressClick(false)
    setDrag({ x: event.clientX, y: event.clientY, rect: root.getBoundingClientRect() })
  }

  const handleTriggerClick = () => {
    if (suppressClick) {
      setSuppressClick(false)
      return
    }
    if (collapsed) setCollapsed(false)
  }

  return (
    <div
      data-testid="wework-dev-instance-badge"
      style={position}
      className="group pointer-events-auto fixed bottom-3 right-3 z-critical max-w-[min(460px,calc(100vw-1.5rem))]"
    >
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid="wework-dev-instance-trigger"
        onClick={handleTriggerClick}
        onPointerDown={handlePointerDown}
        aria-label={collapsed ? 'Expand development instance info' : 'Development instance info'}
        className={cn(
          'ml-auto flex cursor-grab items-center justify-center border border-border/80 bg-background/95 text-xs font-medium text-text-secondary shadow-[0_8px_24px_rgba(0,0,0,0.12)] backdrop-blur active:cursor-grabbing',
          collapsed
            ? 'h-8 w-8 rounded-full'
            : 'max-w-[min(240px,calc(100vw-1.5rem))] rounded-md px-2.5 py-1.5'
        )}
      >
        {collapsed ? (
          <Info className="h-4 w-4" />
        ) : (
          <span className="truncate text-text-primary">{info.title}</span>
        )}
      </ControlButton>
      <div
        className={cn(
          'pointer-events-none absolute w-[min(460px,calc(100vw-1.5rem))] text-xs opacity-0 transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100',
          popoverAbove ? 'bottom-full pb-2' : 'top-full pt-2',
          popoverAlignRight ? 'right-0' : 'left-0'
        )}
      >
        <div className="rounded-lg border border-border/80 bg-background/98 p-2 shadow-[0_18px_48px_rgba(0,0,0,0.18)] backdrop-blur">
          <div className="mb-1 flex items-center justify-between px-2 py-1">
            <span className="font-medium text-text-primary">Development instance</span>
            {!collapsed && (
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="collapse-wework-dev-instance-button"
                className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary wework:hover:bg-black/[0.04]"
                title="Collapse to movable icon"
                aria-label="Collapse development instance info"
                onClick={() => setCollapsed(true)}
              >
                <Minimize2 className="h-3.5 w-3.5" />
              </ControlButton>
            )}
          </div>
          <div className="space-y-1">
            {rows.map(row => (
              <div
                key={row.key}
                className="grid grid-cols-[7.5rem_minmax(0,1fr)_2rem] items-center gap-2 rounded-md px-2 py-1 hover:bg-surface"
              >
                <div className="text-text-muted">{row.label}</div>
                <div
                  className="min-w-0 truncate font-mono text-xs text-text-primary"
                  title={row.value}
                >
                  {row.value}
                </div>
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid={`copy-wework-dev-${row.key}-button`}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary wework:hover:bg-black/[0.04]"
                  title={`Copy ${row.label}`}
                  aria-label={`Copy ${row.label}`}
                  onClick={() => void copyValue(row.key, row.value)}
                >
                  {copiedKey === row.key ? (
                    <Check className="h-3.5 w-3.5 text-primary" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </ControlButton>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
