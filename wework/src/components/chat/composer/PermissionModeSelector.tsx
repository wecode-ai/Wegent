import { ShieldCheck } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { CodexPermissionMode } from '@/types/api'

interface PermissionModeSelectorProps {
  value: CodexPermissionMode
  disabled?: boolean
  onChange: (mode: CodexPermissionMode) => void
}

const modes: CodexPermissionMode[] = ['full_access', 'request_approval', 'approve_for_me']

export function PermissionModeSelector({ value, disabled, onChange }: PermissionModeSelectorProps) {
  const { t } = useTranslation('common')

  return (
    <label className="flex h-8 items-center gap-1 rounded-md px-1.5 text-text-secondary hover:bg-muted">
      <ShieldCheck className="h-4 w-4 shrink-0" />
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
    </label>
  )
}
