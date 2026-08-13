import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

export interface MenuOption {
  value: string
  label: string
  disabled?: boolean
}

export function MenuSelect({
  testId,
  value,
  options,
  onChange,
  pill = false,
  disabled = false,
}: {
  testId: string
  value: string
  options: MenuOption[]
  onChange: (value: string) => void
  pill?: boolean
  disabled?: boolean
}) {
  const selected = options.find(option => option.value === value)
  return (
    <PopupMenu
      testId={testId}
      disabled={disabled}
      trigger={
        <span
          className={cn(
            'inline-flex h-8 max-w-64 items-center justify-end gap-1.5 rounded-full px-2 text-sm font-medium',
            pill && 'bg-surface'
          )}
        >
          <span className="truncate">{selected?.label ?? value}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-text-secondary" />
        </span>
      }
    >
      {close =>
        options.map(option => (
          <button
            key={option.value}
            type="button"
            data-testid={`${testId}-option-${option.value}`}
            disabled={option.disabled}
            onClick={() => {
              if (option.disabled) return
              onChange(option.value)
              close()
            }}
            className="flex h-10 w-full items-center rounded-xl px-3 text-left text-sm font-medium hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.value === value ? <Check className="h-4 w-4 shrink-0" /> : null}
          </button>
        ))
      }
    </PopupMenu>
  )
}

export function TimeMenu({
  testId,
  value,
  onChange,
}: {
  testId: string
  value: string
  onChange: (value: string) => void
}) {
  const options = Array.from({ length: 96 }, (_, index) => {
    const hour = Math.floor(index / 4)
    const minute = (index % 4) * 15
    const raw = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    return { value: raw, label: `${hour}:${String(minute).padStart(2, '0')}` }
  })
  if (!options.some(option => option.value === value)) {
    const [hour = '0', minute = '00'] = value.split(':')
    options.push({ value, label: `${Number(hour)}:${minute}` })
    options.sort((left, right) => left.value.localeCompare(right.value))
  }
  return <MenuSelect testId={testId} value={value} options={options} onChange={onChange} pill />
}

export function WeekdayMenu({
  testId,
  value,
  onChange,
  single = false,
}: {
  testId: string
  value: string[]
  onChange: (value: string[]) => void
  single?: boolean
}) {
  const { t } = useTranslation('common')
  const days = [
    { value: '1', label: t('workbench.automation_monday_short', '周一') },
    { value: '2', label: t('workbench.automation_tuesday_short', '周二') },
    { value: '3', label: t('workbench.automation_wednesday_short', '周三') },
    { value: '4', label: t('workbench.automation_thursday_short', '周四') },
    { value: '5', label: t('workbench.automation_friday_short', '周五') },
    { value: '6', label: t('workbench.automation_saturday_short', '周六') },
    { value: '0', label: t('workbench.automation_sunday_short', '周日') },
  ]
  const selectedLabels = days.filter(day => value.includes(day.value)).map(day => day.label)
  const label =
    selectedLabels.length <= 2
      ? selectedLabels.join(t('workbench.automation_day_joiner', '和'))
      : `${selectedLabels.slice(0, 3).join('、')}…`

  return (
    <PopupMenu
      testId={testId}
      trigger={
        <span className="inline-flex h-8 max-w-64 items-center gap-1.5 rounded-full bg-surface px-2 text-sm font-medium">
          <span className="truncate">
            {label || t('workbench.automation_select_days', '选择日期')}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-text-secondary" />
        </span>
      }
      keepOpen={!single}
    >
      {close =>
        days.map(day => {
          const checked = value.includes(day.value)
          return (
            <button
              key={day.value}
              type="button"
              data-testid={`${testId}-option-${day.value}`}
              onClick={() => {
                if (single) {
                  onChange([day.value])
                  close()
                  return
                }
                const next = checked
                  ? value.filter(current => current !== day.value)
                  : [...value, day.value]
                if (next.length > 0) onChange(next)
              }}
              className="flex h-10 w-full items-center rounded-xl px-3 text-left text-sm font-medium hover:bg-surface"
            >
              <span className="flex-1">{day.label}</span>
              {checked ? <Check className="h-4 w-4" /> : null}
            </button>
          )
        })
      }
    </PopupMenu>
  )
}

export function PopupMenu({
  testId,
  trigger,
  children,
  keepOpen = false,
  disabled = false,
  menuWidth,
}: {
  testId: string
  trigger: ReactNode
  children: (close: () => void) => ReactNode
  keepOpen?: boolean
  disabled?: boolean
  menuWidth?: number
}) {
  const rootRef = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; right: number; width: number } | null>(
    null
  )
  const close = useCallback(() => setOpen(false), [])

  useLayoutEffect(() => {
    if (!open) return
    const triggerRect = rootRef.current?.getBoundingClientRect()
    if (!triggerRect) return
    const width = Math.max(180, triggerRect.width, menuWidth ?? 0)
    const belowTop = triggerRect.bottom + 6
    const estimatedHeight = Math.min(360, menuRef.current?.scrollHeight ?? 320)
    const top =
      belowTop + estimatedHeight <= window.innerHeight - 8
        ? belowTop
        : Math.max(8, triggerRect.top - estimatedHeight - 6)
    setPosition({
      top,
      right: Math.max(8, window.innerWidth - triggerRect.right),
      width,
    })
  }, [menuWidth, open])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) close()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [close, open])

  return (
    <span ref={rootRef} className="inline-flex">
      <button
        type="button"
        data-testid={testId}
        disabled={disabled}
        onClick={() => setOpen(current => !current)}
        className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-50"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {trigger}
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              data-testid={`${testId}-menu`}
              data-embedded-browser-occlusion
              style={{
                top: position?.top ?? 0,
                right: position?.right ?? 0,
                width: position?.width ?? 180,
                visibility: position ? 'visible' : 'hidden',
              }}
              onClick={() => {
                if (!keepOpen) close()
              }}
              className="fixed z-[11000] max-h-[360px] overflow-y-auto rounded-2xl border border-border bg-background p-1.5 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
              role="menu"
            >
              {children(close)}
            </div>,
            document.body
          )
        : null}
    </span>
  )
}
