import type { ComponentType, MouseEvent } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal } from 'lucide-react'

const MENU_GAP = 8
const VIEWPORT_PADDING = 8
const MIN_MENU_WIDTH = 176

export interface ActionMenuItem {
  label: string
  icon: ComponentType<{ className?: string }>
  onSelect: () => void | Promise<void>
  testId: string
  danger?: boolean
  disabled?: boolean
}

interface ActionMenuProps {
  ariaLabel: string
  testId: string
  items: ActionMenuItem[]
  icon?: ComponentType<{ className?: string }>
  variant?: 'horizontal' | 'vertical'
  triggerClassName?: string
  placement?: 'side' | 'bottom-end'
  contextMenuPosition?: MenuPosition | null
  onContextMenuClose?: () => void
}

export interface MenuPosition {
  left: number
  top: number
}

export function ActionMenu({
  ariaLabel,
  testId,
  items,
  icon: Icon = MoreHorizontal,
  variant = 'horizontal',
  triggerClassName,
  placement = 'side',
  contextMenuPosition,
  onContextMenuClose,
}: ActionMenuProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const pointerSelectionRef = useRef(false)
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)

  const closeMenu = useCallback(() => {
    setOpen(false)
    setMenuPosition(null)
    onContextMenuClose?.()
  }, [onContextMenuClose])
  const menuOpen = open || Boolean(contextMenuPosition)

  const handleTriggerClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (!open) {
      setMenuPosition(null)
    }
    if (menuOpen) {
      closeMenu()
    } else {
      setOpen(true)
    }
  }

  const handleItemSelect = async (item: ActionMenuItem) => {
    if (item.disabled) return
    closeMenu()
    await item.onSelect()
  }

  useLayoutEffect(() => {
    if (!menuOpen) return

    const updatePosition = () => {
      const menu = menuRef.current
      if (!menu) return

      const menuRect = menu.getBoundingClientRect()
      const menuWidth = Math.max(menuRect.width, MIN_MENU_WIDTH)
      const menuHeight = menuRect.height
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight

      const maxLeft = viewportWidth - menuWidth - VIEWPORT_PADDING
      const maxTop = viewportHeight - menuHeight - VIEWPORT_PADDING
      if (contextMenuPosition) {
        setMenuPosition({
          left: Math.max(VIEWPORT_PADDING, Math.min(contextMenuPosition.left, maxLeft)),
          top: Math.max(VIEWPORT_PADDING, Math.min(contextMenuPosition.top, maxTop)),
        })
        return
      }

      const trigger = containerRef.current
      if (!trigger) return
      const triggerRect = trigger.getBoundingClientRect()
      if (placement === 'bottom-end') {
        const belowTop = triggerRect.bottom + MENU_GAP
        const aboveTop = triggerRect.top - menuHeight - MENU_GAP
        const top =
          belowTop + menuHeight <= viewportHeight - VIEWPORT_PADDING
            ? belowTop
            : Math.max(VIEWPORT_PADDING, aboveTop)
        const left = Math.max(VIEWPORT_PADDING, Math.min(triggerRect.right - menuWidth, maxLeft))
        setMenuPosition({ left, top })
        return
      }

      const rightSideLeft = triggerRect.right + MENU_GAP
      const leftSideLeft = triggerRect.left - menuWidth - MENU_GAP
      const hasRoomOnRight = rightSideLeft + menuWidth <= viewportWidth - VIEWPORT_PADDING
      const preferredLeft = hasRoomOnRight ? rightSideLeft : leftSideLeft
      const left = Math.max(VIEWPORT_PADDING, Math.min(preferredLeft, maxLeft))
      const top = Math.max(VIEWPORT_PADDING, Math.min(triggerRect.top, maxTop))

      setMenuPosition({ left, top })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [contextMenuPosition, menuOpen, placement])

  useEffect(() => {
    if (!menuOpen) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!containerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        closeMenu()
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeMenu, menuOpen])

  return (
    <div
      ref={containerRef}
      className="relative shrink-0"
      onClick={event => event.stopPropagation()}
    >
      <button
        type="button"
        data-testid={testId}
        onClick={handleTriggerClick}
        className={
          triggerClassName ??
          'flex h-7 w-7 items-center justify-center rounded-md text-[#606368] hover:bg-white/80 hover:text-[#2d2d2d]'
        }
        aria-label={ariaLabel}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
      >
        <Icon className={variant === 'vertical' ? 'h-4 w-4 rotate-90' : 'h-4 w-4'} />
      </button>
      {menuOpen &&
        createPortal(
          <div
            ref={menuRef}
            data-testid={`${testId}-menu`}
            style={{
              left: menuPosition?.left ?? 0,
              top: menuPosition?.top ?? 0,
              visibility: menuPosition ? 'visible' : 'hidden',
            }}
            className="fixed z-[70] min-w-[176px] rounded-2xl border border-border bg-background p-1.5 text-text-primary shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
          >
            {items.map(item => (
              <button
                key={item.testId}
                type="button"
                data-testid={item.testId}
                disabled={item.disabled}
                onPointerDown={event => {
                  if (item.disabled) return
                  event.preventDefault()
                  event.stopPropagation()
                  pointerSelectionRef.current = true
                  void handleItemSelect(item)
                }}
                onClick={() => {
                  if (pointerSelectionRef.current) {
                    pointerSelectionRef.current = false
                    return
                  }
                  void handleItemSelect(item)
                }}
                className={[
                  'flex h-8 w-full items-center gap-2 rounded-lg px-3 text-left text-[13px] leading-[18px]',
                  item.danger ? 'text-red-500 hover:bg-red-50' : 'text-text-primary hover:bg-muted',
                  item.disabled ? 'cursor-not-allowed opacity-45 hover:bg-transparent' : '',
                ].join(' ')}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  )
}
