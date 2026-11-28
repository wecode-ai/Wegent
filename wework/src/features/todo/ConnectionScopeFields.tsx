import { useTranslation } from '@/hooks/useTranslation'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'

const scopeRules = ['off', 'all', 'include', 'exclude'] as const
export type ConnectionScopeRule = (typeof scopeRules)[number]

type Option<T extends string> = { value: T; label: string }
type ChoiceProps<T extends string> = {
  label: string
  value: T
  options: readonly Option<T>[]
  disabled?: boolean
  testId: string
  onChange(value: T): void
}

export function ConnectionChoice<T extends string>({
  label,
  value,
  options,
  disabled,
  testId,
  onChange,
}: ChoiceProps<T>) {
  return (
    <div className="flex min-h-9 flex-wrap items-center justify-between gap-2 text-sm">
      <span className="font-medium">{label}</span>
      <SelectRoot
        value={value}
        disabled={disabled}
        onValueChange={next => {
          const option = options.find(option => option.value === next)
          if (option) onChange(option.value)
        }}
      >
        <SelectTrigger aria-label={label} data-testid={testId}>
          {options.find(option => option.value === value)?.label}
        </SelectTrigger>
        <SelectContent>
          {options.map(option => (
            <SelectItem
              key={option.value}
              value={option.value}
              data-testid={`${testId}-${option.value}`}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectRoot>
    </div>
  )
}

export function ConnectionRulePicker({
  rules = scopeRules,
  labels,
  ...props
}: Omit<ChoiceProps<ConnectionScopeRule>, 'options' | 'label'> & {
  rules?: readonly ConnectionScopeRule[]
  labels?: Partial<Record<ConnectionScopeRule, string>>
}) {
  const { t } = useTranslation('common')
  return (
    <ConnectionChoice
      {...props}
      label={t('standIn.workspace.connection_scope_rule')}
      options={rules.map(value => ({
        value,
        label: labels?.[value] ?? t(`standIn.workspace.connection_rule_${value}`),
      }))}
    />
  )
}

export function ConnectionFixedTrigger({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex min-h-9 flex-wrap items-center justify-between gap-2 text-sm">
      <span className="font-medium">{label}</span>
      <span className="text-text-secondary">{value}</span>
    </p>
  )
}
