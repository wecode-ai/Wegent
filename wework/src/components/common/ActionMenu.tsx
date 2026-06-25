import type { ComponentType, MouseEvent } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal } from 'lucide-react'

const MENU_GAP = 8
const VIEWPORT_PADDING = 8
const MIN_MENU_WIDTH = 176

interface ActionMenuItem {
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
}

interface MenuPosition {
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
}: ActionMenuProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const pointerSelectionRef = useRef(false)
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)

  const handleTriggerClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (!open) {
      setMenuPosition(null)
    }
    setOpen(value => !value)
  }

  const handleItemSelect = async (item: ActionMenuItem) => {
    if (item.disabled) return
    setOpen(false)
    setMenuPosition(null)
    await item.onSelect()
  }

  useLayoutEffect(() => {
    if (!open) return

    const updatePosition = () => {
      const trigger = containerRef.current
      const menu = menuRef.current
      if (!trigger || !menu) return

      const triggerRect = trigger.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      const menuWidth = Math.max(menuRect.width, MIN_MENU_WIDTH)
      const menuHeight = menuRect.height
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight

      const rightSideLeft = triggerRect.right + MENU_GAP
      const leftSideLeft = triggerRect.left - menuWidth - MENU_GAP
      const hasRoomOnRight = rightSideLeft + menuWidth <= viewportWidth - VIEWPORT_PADDING

      const maxLeft = viewportWidth - menuWidth - VIEWPORT_PADDING
      const preferredLeft = hasRoomOnRight ? rightSideLeft : leftSideLeft
      const left = Math.max(VIEWPORT_PADDING, Math.min(preferredLeft, maxLeft))

      const maxTop = viewportHeight - menuHeight - VIEWPORT_PADDING
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
  }, [open])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!containerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false)
        setMenuPosition(null)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

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
        aria-expanded={open}
      >
        <Icon className={variant === 'vertical' ? 'h-4 w-4 rotate-90' : 'h-4 w-4'} />
      </button>
      {open &&
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
