import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@wegent/collaboration/controls/Field'
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from '@wegent/collaboration/controls/MenuParts'
import {
  controlFieldAppearance,
  controlFieldDensity,
  controlTrigger,
} from '@wegent/collaboration/controls/recipes'
import { SelectField } from '@wegent/collaboration/controls/SelectField'
import { Check, ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'

export interface MenuOption {
  value: string
  label: string
  icon?: ReactNode
  ariaLabel?: string
  disabled?: boolean
}

interface MenuAction {
  label: string
  testId: string
  icon?: ReactNode
  onSelect: () => void
}

export function MenuSelect({
  testId,
  value,
  options,
  onChange,
  action,
  pill = false,
  disabled = false,
  placeholder,
  invalid = false,
  field,
  fullWidth = false,
  label,
  accessibleLabel,
  description,
  error,
}: {
  testId: string
  value: string
  options: MenuOption[]
  onChange: (value: string) => void
  action?: MenuAction
  pill?: boolean
  disabled?: boolean
  placeholder?: string
  invalid?: boolean
  fullWidth?: boolean
} & (
  | {
      field: true
      label: string
      description?: ReactNode
      error?: ReactNode
      accessibleLabel?: never
    }
  | { field?: false; accessibleLabel: string; label?: never; description?: never; error?: never }
)) {
  const selected = options.find(option => option.value === value)
  const select = (
    <SelectField
      testId={testId}
      value={value}
      options={options}
      onChange={onChange}
      accessibleLabel={field ? label : accessibleLabel}
      disabled={disabled}
      invalid={invalid || Boolean(error)}
      placeholder={placeholder}
      density={field ? 'default' : 'dense'}
      appearance={field ? 'outline' : 'plain'}
      className={cn(pill && 'bg-surface', (field || fullWidth) && 'w-full')}
      triggerContent={
        <span
          className="flex min-w-0 flex-1 items-center gap-2"
          data-selection-state={value ? 'selected' : 'unselected'}
          data-value={value}
          data-invalid={invalid || undefined}
        >
          {selected?.icon}
          <span className="truncate">{selected?.label ?? placeholder ?? value}</span>
        </span>
      }
      footer={
        action && (
          <Button
            variant="ghost"
            data-testid={action.testId}
            onClick={action.onSelect}
            className="w-full justify-start"
          >
            {action.icon}
            {action.label}
          </Button>
        )
      }
    />
  )
  return field ? (
    <Field disabled={disabled} invalid={invalid || Boolean(error)}>
      <FieldLabel>{label}</FieldLabel>
      {select}
      {description && <FieldDescription>{description}</FieldDescription>}
      {error && <FieldError>{error}</FieldError>}
    </Field>
  ) : (
    select
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
  const { t } = useTranslation('common')
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
  return (
    <MenuSelect
      accessibleLabel={t('workbench.project_automation_time', '执行时间')}
      testId={testId}
      value={value}
      options={options}
      onChange={onChange}
      pill
    />
  )
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
    <Menu>
      <MenuTrigger
        data-testid={testId}
        aria-label={t('workbench.automation_select_days', '选择日期')}
        className={cn(controlTrigger, controlFieldAppearance.plain, controlFieldDensity.dense)}
      >
        <span className="max-w-64 truncate">
          {label || t('workbench.automation_select_days', '选择日期')}
        </span>
        <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
      </MenuTrigger>
      <MenuContent data-testid={testId + '-menu'} align="end" data-embedded-browser-occlusion>
        {single ? (
          <MenuRadioGroup value={value[0] ?? ''} onValueChange={day => onChange([day])}>
            {days.map(day => (
              <MenuRadioItem
                key={day.value}
                value={day.value}
                closeOnSelect
                data-testid={testId + '-option-' + day.value}
              >
                <span className="flex-1">{day.label}</span>
                <MenuItemIndicator>
                  <Check aria-hidden="true" className="h-4 w-4" />
                </MenuItemIndicator>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        ) : (
          days.map(day => (
            <MenuCheckboxItem
              key={day.value}
              value={day.value}
              checked={value.includes(day.value)}
              data-testid={testId + '-option-' + day.value}
              onCheckedChange={(checked, details) => {
                const next = checked
                  ? [...value, day.value]
                  : value.filter(current => current !== day.value)
                if (next.length === 0) details.cancel()
                else onChange(next)
              }}
            >
              <span className="flex-1">{day.label}</span>
              <MenuItemIndicator>
                <Check aria-hidden="true" className="h-4 w-4" />
              </MenuItemIndicator>
            </MenuCheckboxItem>
          ))
        )}
      </MenuContent>
    </Menu>
  )
}
