import { Check, ChevronDown, Hand, Search, Settings, Shield } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useOutsideClick } from './useOutsideClick'

const permissionModes = [
  {
    key: 'default_permission',
    fallback: '默认权限',
    icon: Hand,
  },
  {
    key: 'auto_review',
    fallback: '自动审查',
    icon: Search,
  },
  {
    key: 'full_access_permission',
    fallback: '完全访问权限',
    icon: Shield,
  },
  {
    key: 'custom_config_mode',
    fallback: '自定义 (config.toml)',
    icon: Settings,
  },
] as const

type PermissionModeKey = (typeof permissionModes)[number]['key']

export function DesktopModeSelector() {
  const { t } = useTranslation('common')
  const containerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [selectedMode, setSelectedMode] = useState<PermissionModeKey>('custom_config_mode')
  const closeMenu = useCallback(() => setOpen(false), [])

  useOutsideClick(containerRef, open, closeMenu)

  return (
    <div ref={containerRef} className="relative">
      {open && (
        <div
          data-testid="custom-mode-menu"
          className="absolute bottom-[52px] left-0 z-40 w-80 overflow-hidden rounded-2xl border border-border bg-base p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
        >
          <div className="space-y-1">
            {permissionModes.map(mode => {
              const Icon = mode.icon
              const selected = mode.key === selectedMode

              return (
                <button
                  key={mode.key}
                  type="button"
                  data-testid={`permission-mode-option-${mode.key}`}
                  onClick={() => {
                    setSelectedMode(mode.key)
                    setOpen(false)
                  }}
                  className="flex h-12 w-full items-center gap-3 rounded-xl px-4 text-left text-base font-semibold text-text-primary hover:bg-muted"
                >
                  <Icon className="h-5 w-5 shrink-0 text-text-secondary" />
                  <span className="min-w-0 flex-1 truncate">
                    {t(`workbench.${mode.key}`, mode.fallback)}
                  </span>
                  {selected && <Check className="h-5 w-5 shrink-0 text-text-secondary" />}
                </button>
              )
            })}
          </div>
        </div>
      )}
      <button
        type="button"
        data-testid="custom-mode-button"
        onClick={() => setOpen(current => !current)}
        className="flex h-11 min-w-[44px] items-center gap-2 rounded-full px-2 text-sm font-medium text-text-secondary hover:bg-muted"
        aria-expanded={open}
        aria-label={t('workbench.custom_mode', '自定义')}
      >
        <Settings className="h-5 w-5" />
        <span>{t('workbench.custom_mode', '自定义')}</span>
        <ChevronDown className="h-4 w-4" />
      </button>
    </div>
  )
}
