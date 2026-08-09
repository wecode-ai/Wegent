import type {
  ComponentType,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  MutableRefObject,
  ReactNode,
} from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react'
import { KeyboardShortcut } from './KeyboardShortcut'

const MENU_GAP = 8
const VIEWPORT_PADDING = 8
const MIN_MENU_WIDTH = 176
const SHORTCUT_MODIFIER_ALIASES: Record<string, string> = {
  Cmd: 'Command',
  Meta: 'Command',
  Ctrl: 'Control',
  Option: 'Alt',
}

function formatActionMenuShortcut(shortcut: string): string {
  const parts = shortcut
    .split('+')
    .map(part => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return ''
  const key = parts[parts.length - 1]
  const modifiers = ['Control', 'Alt', 'Shift', 'Command'].filter(modifier =>
    parts.slice(0, -1).some(part => (SHORTCUT_MODIFIER_ALIASES[part] ?? part) === modifier)
  )
  return [...modifiers, key].join('+')
}

export interface ActionMenuItem {
  label: ReactNode
  icon?: ComponentType<{ className?: string }>
  onSelect?: () => void | Promise<void>
  testId: string
  danger?: boolean
  disabled?: boolean
  shortcut?: string
  children?: ActionMenuItem[]
}

interface ActionMenuProps {
  ariaLabel: string
  testId: string
  items: ActionMenuItem[]
  icon?: ComponentType<{ className?: string }>
  triggerLabel?: ReactNode
  disabled?: boolean
  variant?: 'horizontal' | 'vertical'
  triggerClassName?: string
  placement?: 'side' | 'bottom-end'
  contextMenuPosition?: MenuPosition | null
  onContextMenuClose?: () => void
  onOpenChange?: (open: boolean) => void
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
  triggerLabel,
  disabled = false,
  variant = 'horizontal',
  triggerClassName,
  placement = 'side',
  contextMenuPosition,
  onContextMenuClose,
  onOpenChange,
}: ActionMenuProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const submenuItemRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const pointerSelectionRef = useRef(false)
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null)
  const [submenuPosition, setSubmenuPosition] = useState<MenuPosition | null>(null)

  const closeMenu = useCallback(
    (restoreFocus = false) => {
      setOpen(false)
      setMenuPosition(null)
      setOpenSubmenuId(null)
      setSubmenuPosition(null)
      onContextMenuClose?.()
      onOpenChange?.(false)
      if (restoreFocus) {
        window.requestAnimationFrame(() => triggerRef.current?.focus())
      }
    },
    [onContextMenuClose, onOpenChange]
  )
  const menuOpen = open || Boolean(contextMenuPosition)
  const openSubmenuItem = items.find(item => item.testId === openSubmenuId)

  const handleTriggerClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (disabled) return
    if (!open) {
      setMenuPosition(null)
    }
    if (menuOpen) {
      closeMenu()
    } else {
      setOpen(true)
      onOpenChange?.(true)
    }
  }

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    if (!menuOpen) {
      setMenuPosition(null)
      setOpen(true)
      onOpenChange?.(true)
    }
  }

  const handleItemSelect = async (item: ActionMenuItem) => {
    if (item.disabled || item.children?.length || !item.onSelect) return
    closeMenu()
    await item.onSelect()
  }

  const openSubmenu = useCallback((item: ActionMenuItem) => {
    if (item.disabled || !item.children?.length) return
    setOpenSubmenuId(item.testId)
    setSubmenuPosition(null)
  }, [])

  const focusAdjacentItem = (
    menuItems: ActionMenuItem[],
    currentId: string,
    refs: MutableRefObject<Record<string, HTMLButtonElement | null>>,
    direction: 1 | -1
  ) => {
    const availableItems = menuItems.filter(item => !item.disabled)
    const currentIndex = availableItems.findIndex(item => item.testId === currentId)
    if (currentIndex < 0 || availableItems.length === 0) return
    const nextIndex = (currentIndex + direction + availableItems.length) % availableItems.length
    refs.current[availableItems[nextIndex].testId]?.focus()
  }

  const handleItemKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    item: ActionMenuItem,
    submenu = false
  ) => {
    if (item.disabled) return
    if (
      event.key === 'ArrowDown' ||
      event.key === 'ArrowUp' ||
      event.key === 'Home' ||
      event.key === 'End'
    ) {
      event.preventDefault()
      const menuItems = submenu ? (openSubmenuItem?.children ?? []) : items
      const availableItems = menuItems.filter(menuItem => !menuItem.disabled)
      if (availableItems.length === 0) return
      const targetId =
        event.key === 'Home'
          ? availableItems[0]?.testId
          : event.key === 'End'
            ? availableItems[availableItems.length - 1]?.testId
            : null
      if (targetId) {
        ;(submenu ? submenuItemRefs : itemRefs).current[targetId]?.focus()
        return
      }
      focusAdjacentItem(
        menuItems,
        item.testId,
        submenu ? submenuItemRefs : itemRefs,
        event.key === 'ArrowDown' ? 1 : -1
      )
      return
    }
    if (!submenu && event.key === 'ArrowRight' && item.children?.length) {
      event.preventDefault()
      openSubmenu(item)
      return
    }
    if (submenu && event.key === 'ArrowLeft') {
      event.preventDefault()
      setOpenSubmenuId(null)
      setSubmenuPosition(null)
      itemRefs.current[openSubmenuId ?? '']?.focus()
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (item.children?.length) {
        openSubmenu(item)
      } else {
        void handleItemSelect(item)
      }
    }
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

  useLayoutEffect(() => {
    if (!menuOpen || !openSubmenuId) return

    const updatePosition = () => {
      const parentItem = itemRefs.current[openSubmenuId]
      const submenu = submenuRef.current
      if (!parentItem || !submenu) return

      const parentRect = parentItem.getBoundingClientRect()
      const submenuRect = submenu.getBoundingClientRect()
      const submenuWidth = Math.max(submenuRect.width, MIN_MENU_WIDTH)
      const maxLeft = window.innerWidth - submenuWidth - VIEWPORT_PADDING
      const maxTop = window.innerHeight - submenuRect.height - VIEWPORT_PADDING
      const right = parentRect.right + MENU_GAP
      const left =
        right + submenuWidth <= window.innerWidth - VIEWPORT_PADDING
          ? right
          : parentRect.left - submenuWidth - MENU_GAP
      setSubmenuPosition({
        left: Math.max(VIEWPORT_PADDING, Math.min(left, maxLeft)),
        top: Math.max(VIEWPORT_PADDING, Math.min(parentRect.top, maxTop)),
      })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [menuOpen, openSubmenuId])

  useEffect(() => {
    if (!openSubmenuId) return
    const parentItem = items.find(item => item.testId === openSubmenuId)
    const firstChild = parentItem?.children?.find(item => !item.disabled)
    submenuItemRefs.current[firstChild?.testId ?? '']?.focus()
  }, [items, openSubmenuId])

  useEffect(() => {
    if (!menuOpen) return

    const animationFrame = window.requestAnimationFrame(() => {
      const items = menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)'
      )
      if (!items?.length) return
      const target = document.activeElement === triggerRef.current ? items[0] : null
      target?.focus()
    })

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (
        !containerRef.current?.contains(target) &&
        !menuRef.current?.contains(target) &&
        !submenuRef.current?.contains(target)
      ) {
        closeMenu()
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (openSubmenuId) {
        setOpenSubmenuId(null)
        setSubmenuPosition(null)
        itemRefs.current[openSubmenuId]?.focus()
        return
      }
      closeMenu(true)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(animationFrame)
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeMenu, menuOpen, openSubmenuId])

  return (
    <div
      ref={containerRef}
      className="relative shrink-0"
      onClick={event => event.stopPropagation()}
    >
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        disabled={disabled}
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
        className={
          triggerClassName ??
          'flex h-7 w-7 items-center justify-center rounded-md text-[#606368] hover:bg-white/80 hover:text-[#2d2d2d]'
        }
        aria-label={ariaLabel}
        title={ariaLabel}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
      >
        <Icon className={variant === 'vertical' ? 'h-4 w-4 rotate-90' : 'h-4 w-4'} />
        {triggerLabel}
        {triggerLabel ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : null}
      </button>
      {menuOpen &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            data-testid={`${testId}-menu`}
            data-embedded-browser-occlusion
            aria-label={ariaLabel}
            style={{
              left: menuPosition?.left ?? 0,
              top: menuPosition?.top ?? 0,
              visibility: menuPosition ? 'visible' : 'hidden',
            }}
            className="fixed z-system-popover min-w-[176px] rounded-xl border border-border bg-popover p-1 text-text-primary shadow-xl"
          >
            {items.map(item => {
              const ItemIcon = item.icon
              return (
                <button
                  key={item.testId}
                  type="button"
                  data-testid={item.testId}
                  ref={element => {
                    itemRefs.current[item.testId] = element
                  }}
                  role="menuitem"
                  disabled={item.disabled}
                  aria-haspopup={item.children?.length ? 'menu' : undefined}
                  aria-expanded={item.children?.length ? openSubmenuId === item.testId : undefined}
                  onPointerEnter={() => openSubmenu(item)}
                  onPointerDown={event => {
                    if (item.disabled) return
                    event.preventDefault()
                    event.stopPropagation()
                    pointerSelectionRef.current = true
                    if (item.children?.length) {
                      openSubmenu(item)
                    } else {
                      void handleItemSelect(item)
                    }
                  }}
                  onClick={() => {
                    if (pointerSelectionRef.current) {
                      pointerSelectionRef.current = false
                      return
                    }
                    if (item.children?.length) {
                      openSubmenu(item)
                    } else {
                      void handleItemSelect(item)
                    }
                  }}
                  onKeyDown={event => handleItemKeyDown(event, item)}
                  className={[
                    'flex h-8 w-full items-center gap-2 rounded-lg px-3 text-left text-sm leading-[18px]',
                    item.danger
                      ? 'text-red-500 hover:bg-red-50'
                      : 'text-text-primary hover:bg-muted',
                    item.disabled ? 'cursor-not-allowed opacity-45 hover:bg-transparent' : '',
                  ].join(' ')}
                >
                  {ItemIcon ? <ItemIcon className="h-4 w-4 shrink-0" /> : null}
                  <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
                    {item.label}
                  </span>
                  {item.shortcut ? (
                    <KeyboardShortcut
                      value={formatActionMenuShortcut(item.shortcut)}
                      className="ml-auto h-5 bg-muted px-1.5 text-xs text-text-secondary"
                    />
                  ) : null}
                  {item.children?.length ? <ChevronRight className="ml-auto h-4 w-4" /> : null}
                </button>
              )
            })}
          </div>,
          document.body
        )}
      {menuOpen && openSubmenuItem?.children?.length
        ? createPortal(
            <div
              ref={submenuRef}
              role="menu"
              data-testid={`${openSubmenuItem.testId}-submenu`}
              data-embedded-browser-occlusion
              style={{
                left: submenuPosition?.left ?? 0,
                top: submenuPosition?.top ?? 0,
                visibility: submenuPosition ? 'visible' : 'hidden',
              }}
              className="fixed z-[71] min-w-[176px] rounded-xl border border-border bg-popover p-1 text-text-primary shadow-xl"
            >
              {openSubmenuItem.children.map(item => {
                const ItemIcon = item.icon
                return (
                  <button
                    key={item.testId}
                    type="button"
                    data-testid={item.testId}
                    ref={element => {
                      submenuItemRefs.current[item.testId] = element
                    }}
                    role="menuitem"
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
                    onKeyDown={event => handleItemKeyDown(event, item, true)}
                    className={[
                      'flex h-8 w-full items-center gap-2 rounded-lg px-3 text-left text-sm leading-[18px]',
                      item.danger
                        ? 'text-red-500 hover:bg-red-50'
                        : 'text-text-primary hover:bg-muted',
                      item.disabled ? 'cursor-not-allowed opacity-45 hover:bg-transparent' : '',
                    ].join(' ')}
                  >
                    {ItemIcon ? <ItemIcon className="h-4 w-4 shrink-0" /> : null}
                    <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
                      {item.label}
                    </span>
                    {item.shortcut ? (
                      <KeyboardShortcut
                        value={formatActionMenuShortcut(item.shortcut)}
                        className="ml-auto h-5 bg-muted px-1.5 text-xs text-text-secondary"
                      />
                    ) : null}
                  </button>
                )
              })}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
