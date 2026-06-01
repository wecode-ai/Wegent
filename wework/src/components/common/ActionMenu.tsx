import type { ComponentType, MouseEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'

interface ActionMenuItem {
  label: string
  icon: ComponentType<{ className?: string }>
  onSelect: () => void | Promise<void>
  testId: string
  danger?: boolean
}

interface ActionMenuProps {
  ariaLabel: string
  testId: string
  items: ActionMenuItem[]
  icon?: ComponentType<{ className?: string }>
  variant?: 'horizontal' | 'vertical'
}

export function ActionMenu({
  ariaLabel,
  testId,
  items,
  icon: Icon = MoreHorizontal,
  variant = 'horizontal',
}: ActionMenuProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const pointerSelectionRef = useRef(false)

  const handleTriggerClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    setOpen(value => !value)
  }

  const handleItemSelect = async (item: ActionMenuItem) => {
    setOpen(false)
    await item.onSelect()
  }

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false)
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
        className="flex h-7 w-7 items-center justify-center rounded-md text-[#606368] hover:bg-white/80 hover:text-[#2d2d2d]"
        aria-label={ariaLabel}
        aria-expanded={open}
      >
        <Icon className={variant === 'vertical' ? 'h-4 w-4 rotate-90' : 'h-4 w-4'} />
      </button>
      {open && (
        <div
          data-testid={`${testId}-menu`}
          className="absolute right-0 top-8 z-50 min-w-[176px] rounded-lg border border-black/10 bg-[#2b2b2b] py-1.5 text-white shadow-xl"
        >
          {items.map(item => (
            <button
              key={item.testId}
              type="button"
              data-testid={item.testId}
              onPointerDown={event => {
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
                'flex h-9 w-full items-center gap-2 px-3 text-left text-sm',
                item.danger
                  ? 'text-[#ff7b7b] hover:bg-white/10'
                  : 'text-white hover:bg-white/10',
              ].join(' ')}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
