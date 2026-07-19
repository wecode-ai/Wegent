import { ShieldCheck } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { CodexPermissionMode } from '@/types/api'

interface PermissionModeSelectorProps {
  value: CodexPermissionMode
  disabled?: boolean
  mobile?: boolean
  className?: string
  onChange: (mode: CodexPermissionMode) => void
}

const modes: CodexPermissionMode[] = ['full_access', 'request_approval', 'approve_for_me']

export function PermissionModeSelector({
  value,
  disabled,
  mobile = false,
  className = '',
  onChange,
}: PermissionModeSelectorProps) {
  const { t } = useTranslation('common')
  const label = t(`workbench.codex_permission_${value}`)

  return (
    <label
      data-permission-control
      className={`relative flex shrink-0 items-center gap-1 rounded-md text-text-secondary hover:bg-muted ${mobile ? 'h-11 px-3' : 'h-8 px-1.5'} ${className}`}
      title={label}
    >
      <ShieldCheck data-permission-icon className="h-4 w-4 shrink-0" />
      <select
        data-testid="codex-permission-mode-selector"
        value={value}
        disabled={disabled}
        aria-label={t('workbench.general_settings_codex_permissions')}
        onChange={event => onChange(event.target.value as CodexPermissionMode)}
        className="max-w-32 bg-transparent text-sm text-text-secondary outline-none disabled:opacity-50"
      >
        {modes.map(mode => (
          <option key={mode} value={mode}>
            {t(`workbench.codex_permission_${mode}`)}
          </option>
        ))}
      </select>
      <span data-permission-accessible-label className="sr-only">
        {label}
      </span>
    </label>
  )
}
