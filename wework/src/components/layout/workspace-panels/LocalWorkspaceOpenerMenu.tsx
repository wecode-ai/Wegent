import { ChevronDown, Code2, Folder, Monitor, SquareTerminal } from 'lucide-react'
import { createPortal } from 'react-dom'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { LOCAL_WORKSPACE_OPENERS, type LocalWorkspaceOpenerId } from '@/lib/local-workspace-openers'
import { cn } from '@/lib/utils'

const MENU_GAP = 8
const VIEWPORT_PADDING = 8
const MENU_WIDTH = 280

interface MenuPosition {
  left: number
  top: number
}

interface LocalWorkspaceOpenerPickerProps {
  ariaLabel: string
  buttonTestId?: string
  menuTestId?: string
  optionTestIdPrefix?: string
  disabled?: boolean
  buttonClassName: string
  preferredPlacement?: 'above' | 'below'
  align?: 'start' | 'end'
  onSelect: (opener: LocalWorkspaceOpenerId) => void | Promise<void>
}

export function LocalWorkspaceOpenerPicker({
  ariaLabel,
  buttonTestId,
  menuTestId,
  optionTestIdPrefix,
  disabled = false,
  buttonClassName,
  preferredPlacement = 'below',
  align = 'end',
  onSelect,
}: LocalWorkspaceOpenerPickerProps) {
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

  const selectOpener = async (opener: LocalWorkspaceOpenerId) => {
    setOpen(false)
    setPosition(null)
    await onSelect(opener)
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid={buttonTestId}
        onClick={toggleOpen}
        disabled={disabled}
        className={buttonClassName}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <ChevronDown className="h-4 w-4" />
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
            className="fixed z-system-popover max-h-[520px] w-[280px] overflow-y-auto rounded-2xl border border-border bg-popover p-2 text-text-primary shadow-[0_18px_54px_rgba(0,0,0,0.16)] ring-1 ring-black/5"
          >
            {LOCAL_WORKSPACE_OPENERS.map(opener => (
              <button
                key={opener.id}
                type="button"
                role="menuitem"
                data-testid={optionTestIdPrefix ? `${optionTestIdPrefix}-${opener.id}` : undefined}
                onClick={() => void selectOpener(opener.id)}
                className="flex h-10 w-full items-center gap-3 rounded-xl px-2.5 text-left text-base font-medium leading-5 text-text-primary transition-colors hover:bg-muted"
              >
                <LocalWorkspaceOpenerIcon opener={opener.id} className="h-5 w-5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{opener.label}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}

export function LocalWorkspaceOpenerIcon({
  opener,
  className,
}: {
  opener: LocalWorkspaceOpenerId
  className?: string
}) {
  const wrapperClassName = cn(
    'inline-flex items-center justify-center overflow-hidden rounded-md border border-black/5 shadow-sm',
    className
  )

  if (opener === 'vscode' || opener === 'vscode-insiders') {
    const color = opener === 'vscode' ? '#1f7fbf' : '#4aa99d'
    return (
      <span className={cn(wrapperClassName, 'relative bg-background')} aria-hidden="true">
        <span
          data-testid="local-workspace-vscode-mark"
          className="absolute left-[4px] top-[4px] h-[8px] w-[8px] rotate-45 border-b-[2px] border-l-[2px]"
          style={{ borderColor: color }}
        />
        <span
          data-testid="local-workspace-vscode-body"
          className="absolute right-[4px] top-[3px] h-[12px] w-[4px] rounded-sm"
          style={{ backgroundColor: color }}
        />
      </span>
    )
  }

  return (
    <span className={cn(wrapperClassName, openerIconBackground(opener))} aria-hidden="true">
      {openerIconContent(opener)}
    </span>
  )
}

function openerIconBackground(opener: LocalWorkspaceOpenerId): string {
  switch (opener) {
    case 'cursor':
      return 'bg-[#505050] text-white'
    case 'sublime-text':
      return 'bg-[#5b5f64] text-[#ffb64a]'
    case 'windsurf':
      return 'bg-[#f7f7f4] text-[#4d4d4d]'
    case 'finder':
      return 'bg-[#5aa9ff] text-white'
    case 'terminal':
      return 'bg-[#525252] text-white'
    case 'iterm2':
      return 'bg-[#3a3541] text-[#67e887]'
    case 'ghostty':
      return 'bg-[#5969a6] text-white'
    case 'warp':
      return 'bg-[#e6e8eb] text-[#4f5357]'
    case 'xcode':
      return 'bg-[#49b9f2] text-white'
    case 'android-studio':
      return 'bg-white text-[#3f82f8]'
    case 'intellij-idea':
      return 'bg-gradient-to-br from-[#ff6b3d] via-[#d642e9] to-[#2f7df6] text-white'
    default:
      return 'bg-[#f2f7fb] text-[#007ACC]'
  }
}

function openerIconContent(opener: LocalWorkspaceOpenerId): ReactNode {
  switch (opener) {
    case 'finder':
      return <Folder className="h-3.5 w-3.5" />
    case 'terminal':
    case 'iterm2':
    case 'ghostty':
    case 'warp':
      return <SquareTerminal className="h-3.5 w-3.5" />
    case 'xcode':
    case 'android-studio':
    case 'intellij-idea':
      return <Monitor className="h-3.5 w-3.5" />
    case 'cursor':
    case 'sublime-text':
    case 'windsurf':
      return <Code2 className="h-3.5 w-3.5" />
    default:
      return <Code2 className="h-3.5 w-3.5" />
  }
}
