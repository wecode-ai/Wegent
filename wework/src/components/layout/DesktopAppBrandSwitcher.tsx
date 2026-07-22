import { ChevronDown } from 'lucide-react'
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { cn } from '@/lib/utils'

interface DesktopAppBrandSwitcherProps {
  onNavigate: (app: 'wework' | 'wegent') => void
  className?: string
}

interface MenuPosition {
  left: number
  top: number
}

const MENU_WIDTH = 160
const MENU_ROW_HEIGHT = 36
const MENU_VIEWPORT_PADDING = 8

export function DesktopAppBrandSwitcher({ onNavigate, className }: DesktopAppBrandSwitcherProps) {
  const cloudConnection = useContext(CloudConnectionContext)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [menuMounted, setMenuMounted] = useState(false)
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)

  const wegentDisabled = !cloudConnection?.isConnected

  const openMenu = useCallback(() => {
    setMenuMounted(true)
    window.requestAnimationFrame(() => {
      setOpen(true)
    })
  }, [])

  const closeMenu = useCallback(() => {
    setOpen(false)
    window.setTimeout(() => {
      setMenuMounted(false)
      setMenuPosition(null)
    }, 160)
  }, [])

  useEffect(() => {
    if (!menuMounted) return

    const updatePosition = () => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const menuHeight = MENU_ROW_HEIGHT * 2 + 8
      const desiredTop = rect.bottom + 4
      const maxTop = Math.max(
        MENU_VIEWPORT_PADDING,
        window.innerHeight - menuHeight - MENU_VIEWPORT_PADDING
      )
      const top = Math.min(desiredTop, maxTop)
      const left = Math.max(
        MENU_VIEWPORT_PADDING,
        Math.min(rect.left, window.innerWidth - MENU_WIDTH - MENU_VIEWPORT_PADDING)
      )
      setMenuPosition({ left, top })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    return () => window.removeEventListener('resize', updatePosition)
  }, [menuMounted])

  useEffect(() => {
    if (!menuMounted) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
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
  }, [closeMenu, menuMounted])

  const selectApp = useCallback(
    (app: 'wework' | 'wegent') => {
      if (app === 'wegent' && wegentDisabled) return
      closeMenu()
      onNavigate(app)
    },
    [closeMenu, onNavigate, wegentDisabled]
  )

  return (
    <div className={cn('relative flex shrink-0 items-center', className)}>
      <button
        ref={triggerRef}
        type="button"
        data-testid="desktop-app-brand-switcher"
        onClick={() => (open ? closeMenu() : openMenu())}
        className={cn(
          'flex h-8 items-center gap-0.5 rounded-lg px-2 text-sm font-semibold leading-none text-text-primary transition-colors hover:bg-black/[0.06] hover:text-text-secondary',
          open && 'pointer-events-none bg-black/[0.06]'
        )}
        aria-label="切换应用"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="select-none">wework</span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'h-3.5 w-3.5 text-text-muted transition-transform',
            open && 'rotate-180'
          )}
        />
      </button>

      {menuMounted &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            data-testid="desktop-app-brand-switcher-menu"
            style={{
              left: menuPosition?.left ?? 0,
              top: menuPosition?.top ?? 0,
              width: MENU_WIDTH,
            }}
            className={cn(
              'fixed z-system-popover flex flex-col gap-0.5 overflow-hidden rounded-xl border border-border/70 bg-background/95 p-1 text-text-primary shadow-[0_8px_24px_rgba(0,0,0,0.1)] backdrop-blur-md transition-[clip-path,opacity,transform] duration-200 ease-out',
              open
                ? 'translate-y-0 opacity-100 [clip-path:inset(0_0_0_0_round_0.75rem)]'
                : 'pointer-events-none -translate-y-1 opacity-0 [clip-path:inset(0_0_100%_0_round_0.75rem)]'
            )}
          >
            <button
              type="button"
              role="menuitemradio"
              aria-checked
              data-testid="brand-switcher-wework"
              onClick={() => selectApp('wework')}
              className="flex min-h-9 w-full items-center rounded-lg px-2 text-left text-sm font-medium transition-colors hover:bg-black/[0.035]"
            >
              wework
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={false}
              aria-disabled={wegentDisabled || undefined}
              disabled={wegentDisabled}
              data-testid="brand-switcher-wegent"
              onClick={() => selectApp('wegent')}
              className={cn(
                'flex min-h-9 w-full items-center rounded-lg px-2 text-left text-sm font-medium transition-colors',
                wegentDisabled
                  ? 'cursor-not-allowed text-text-muted'
                  : 'hover:bg-black/[0.035]'
              )}
            >
              wegent
            </button>
          </div>,
          document.body
        )}
    </div>
  )
}
