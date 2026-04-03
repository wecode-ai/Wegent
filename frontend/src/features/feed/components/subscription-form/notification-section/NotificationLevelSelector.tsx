'use client'

import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { NotificationLevel } from '@/types/subscription'

interface NotificationLevelOption {
  value: NotificationLevel
  label: string
  description: string
}

interface NotificationLevelSelectorProps {
  label: string
  value: NotificationLevel
  options: NotificationLevelOption[]
  disabled?: boolean
  onChange: (value: NotificationLevel) => void
}

export function NotificationLevelSelector({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: NotificationLevelSelectorProps) {
  const activeOption =
    options.find(option => option.value === value) ?? options[options.length - 1] ?? null

  return (
    <section className="space-y-3 rounded-xl border border-border bg-surface/40 p-4">
      <div className="space-y-1">
        <Label className="text-sm font-medium">{label}</Label>
        {activeOption && (
          <p className="text-xs text-text-muted" data-testid="notification-level-description">
            {activeOption.description}
          </p>
        )}
      </div>

      <ToggleGroup
        type="single"
        value={value}
        onValueChange={nextValue => {
          if (nextValue) {
            onChange(nextValue as NotificationLevel)
          }
        }}
        disabled={disabled}
        className="grid grid-cols-3 gap-2"
      >
        {options.map(option => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            variant="outline"
            className="h-10 w-full rounded-lg px-3"
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </section>
  )
}
