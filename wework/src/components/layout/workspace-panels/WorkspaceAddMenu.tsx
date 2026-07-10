import { Plus } from 'lucide-react'
import { createPortal } from 'react-dom'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type MouseEvent,
} from 'react'
import { setEmbeddedBrowserOcclusion } from '@/lib/embedded-browser'

const MENU_GAP = 8
const VIEWPORT_PADDING = 8
const MENU_WIDTH = 240
const EMBEDDED_BROWSER_OCCLUSION_ID = 'workspace-add-menu'

export interface WorkspaceAddMenuItem {
  id: string
  label: string
  icon: ComponentType<{ className?: string }>
  onSelect: () => void | Promise<void>
  testId?: string
  disabled?: boolean
  shortcut?: string
}

interface WorkspaceAddMenuProps {
  ariaLabel: string
  buttonTestId?: string
  menuTestId?: string
  items: WorkspaceAddMenuItem[]
  buttonClassName: string
  preferredPlacement?: 'above' | 'below'
  align?: 'start' | 'end'
}

interface MenuPosition {
  left: number
  top: number
}

export function WorkspaceAddMenu({
  ariaLabel,
  buttonTestId,
  menuTestId,
  items,
  buttonClassName,
  preferredPlacement = 'below',
  align = 'start',
}: WorkspaceAddMenuProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    if (!open) return

    const updatePosition = () => {
      const buttonRect = buttonRef.current?.getBoundingClientRect()
      const menuRect = menuRef.current?.getBoundingClientRect()
      if (!buttonRect || !menuRect) return

      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const menuWidth = Math.max(menuRect.width, MENU_WIDTH)
      const menuHeight = menuRect.height
      const belowTop = buttonRect.bottom + MENU_GAP
      const aboveTop = buttonRect.top - menuHeight - MENU_GAP
      const hasRoomBelow = belowTop + menuHeight <= viewportHeight - VIEWPORT_PADDING
      const hasRoomAbove = aboveTop >= VIEWPORT_PADDING
      const placeBelow =
        preferredPlacement === 'below'
          ? hasRoomBelow || !hasRoomAbove
          : !(hasRoomAbove || !hasRoomBelow)
      const top = placeBelow ? belowTop : Math.max(VIEWPORT_PADDING, aboveTop)
      const preferredLeft = align === 'end' ? buttonRect.right - menuWidth : buttonRect.left
      const maxLeft = viewportWidth - menuWidth - VIEWPORT_PADDING
      const left = Math.max(VIEWPORT_PADDING, Math.min(preferredLeft, maxLeft))

      setPosition({ left, top })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [align, open, preferredPlacement])

  useEffect(() => {
    if (!open) return

    setEmbeddedBrowserOcclusion(EMBEDDED_BROWSER_OCCLUSION_ID, true)
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return
      }
      setOpen(false)
      setPosition(null)
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        setPosition(null)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      setEmbeddedBrowserOcclusion(EMBEDDED_BROWSER_OCCLUSION_ID, false)
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const toggleOpen = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()

    if (open) {
      setOpen(false)
      setPosition(null)
      return
    }

    setPosition(null)
    setOpen(true)
  }

  const selectItem = async (item: WorkspaceAddMenuItem) => {
    if (item.disabled) return

    setOpen(false)
    setPosition(null)
    await item.onSelect()
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid={buttonTestId}
        onClick={toggleOpen}
        className={buttonClassName}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Plus className="h-4 w-4" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            data-testid={menuTestId}
            role="menu"
            style={{
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              visibility: position ? 'visible' : 'hidden',
            }}
            className="fixed z-system-popover w-[240px] rounded-xl border border-border bg-popover p-1.5 text-text-primary shadow-[0_16px_44px_rgba(0,0,0,0.16)] ring-1 ring-black/5"
          >
            {items.map(item => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                data-testid={item.testId}
                disabled={item.disabled}
                onClick={() => void selectItem(item)}
                className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm font-medium leading-5 text-text-primary transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
              >
                <item.icon className="h-4 w-4 shrink-0 text-text-secondary" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.shortcut && (
                  <span className="shrink-0 text-xs font-medium text-text-muted">
                    {item.shortcut}
                  </span>
                )}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}
