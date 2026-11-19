import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import type { WeworkDshApp } from '@/features/dsh-runtime/dshApps'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotEntries } from '@/features/dsh-runtime/useDshSlotEntries'
import { useTranslation } from '@/hooks/useTranslation'
import { dispatchOpenSettingsShortcut } from '@/lib/keybindings'
import { cn } from '@/lib/utils'
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '@wegent/collaboration/controls/MenuParts'
import { controlOption, controlPopup } from '@wegent/collaboration/controls/recipes'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useCollaborationPortalTheme } from '@wegent/collaboration/theme'
import { Check, ChevronDown, CloudOff, Settings } from 'lucide-react'
import { useContext, useMemo, useState } from 'react'

export type DesktopAppKey = string

interface DesktopAppSwitcherProps {
  activeApp: DesktopAppKey
  onNavigate: (app: DesktopAppKey) => void
  className?: string
  testIds?: Partial<Record<DesktopAppKey, string>>
  variant?: 'menu' | 'tabs'
}

interface AppOption {
  key: DesktopAppKey
  label: string
  description: string
  availabilityLabel?: string
  disabled?: boolean
}

export function DesktopAppSwitcher({
  activeApp,
  onNavigate,
  className,
  testIds,
  variant = 'menu',
}: DesktopAppSwitcherProps) {
  const { t } = useTranslation('common')
  const cloudConnection = useContext(CloudConnectionContext)
  const registeredApps = useDshSlotEntries<WeworkDshApp>(WEWORK_DSH_SLOTS.app)
  const [open, setOpen] = useState(false)
  const theme = useCollaborationPortalTheme()
  const options = useMemo<AppOption[]>(() => {
    return registeredApps
      .filter(app => !app.hiddenInSwitcher)
      .map(app => ({
        key: app.id,
        label: t(app.labelKey ?? app.id, app.label),
        description: t(app.descriptionKey ?? `${app.id}.description`, app.description ?? ''),
        availabilityLabel:
          app.requiresCloud && !cloudConnection?.isConnected
            ? t('workbench.app_wegent_requires_cloud', '连接云端后可用')
            : undefined,
        disabled:
          Boolean(app.requiresCloud) && !cloudConnection?.isConnected && activeApp !== app.id,
      }))
  }, [activeApp, cloudConnection?.isConnected, registeredApps, t])
  const selected = options.find(option => option.key === activeApp)
  const triggerTestId = testIds?.[activeApp] ?? 'chrome-tab-' + activeApp
  const navigationLabel = t('workbench.app_navigation', '应用导航')
  if (variant === 'tabs') {
    return (
      <nav
        data-testid="desktop-app-switcher"
        aria-label={t('workbench.app_navigation', '应用导航')}
        className={cn('flex shrink-0 items-center gap-1', className)}
      >
        {options.map(option => {
          const active = option.key === activeApp
          const optionTestId = testIds?.[option.key] ?? `chrome-tab-${option.key}`

          return (
            <ControlButton
              variant="unstyled"
              key={option.key}
              type="button"
              data-testid={optionTestId}
              onClick={() => !option.disabled && onNavigate(option.key)}
              disabled={option.disabled}
              title={option.availabilityLabel ?? option.description}
              aria-label={option.label}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex h-8 items-center rounded-lg px-2 text-sm font-medium leading-none transition-colors',
                active
                  ? 'bg-muted text-text-primary wework:bg-black/[0.045]'
                  : 'text-text-secondary hover:bg-muted hover:text-text-primary wework:hover:bg-black/[0.04]',
                option.disabled &&
                  'cursor-not-allowed opacity-50 hover:bg-transparent wework:hover:bg-transparent'
              )}
            >
              {option.label}
            </ControlButton>
          )
        })}
      </nav>
    )
  }

  return (
    <nav
      data-testid="desktop-app-switcher"
      aria-label={navigationLabel}
      className={cn('flex shrink-0 items-center', className)}
    >
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          render={<button type="button" />}
          data-testid={triggerTestId}
          aria-label={(selected?.label ?? activeApp) + '，' + navigationLabel}
          className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-semibold text-text-primary outline-none hover:bg-muted keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/40 md:min-h-8"
        >
          {selected?.label ?? activeApp}
          <ChevronDown aria-hidden="true" className="h-4 w-4 text-text-muted" />
        </MenuTrigger>
        <MenuContent
          {...theme}
          align="start"
          sideOffset={4}
          collisionPadding={8}
          data-testid="desktop-app-switcher-menu"
          aria-label={navigationLabel}
          className={cn(controlPopup, 'w-76')}
        >
          <MenuRadioGroup
            value={activeApp}
            onValueChange={key => {
              const option = options.find(option => option.key === key)
              if (!option || option.disabled) return
              setOpen(false)
              if (key !== activeApp) onNavigate(key)
            }}
          >
            {options.map(option => (
              <MenuRadioItem
                key={option.key}
                value={option.key}
                disabled={option.disabled}
                render={<button type="button" />}
                data-testid={'app-switcher-option-' + option.key}
                className={controlOption}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{option.label}</span>
                  <span className="block text-xs text-text-secondary">{option.description}</span>
                  {option.availabilityLabel && (
                    <span
                      className="flex items-center gap-1 text-xs text-text-secondary"
                      data-testid={'app-switcher-unavailable-' + option.key}
                    >
                      <CloudOff aria-hidden="true" className="h-4 w-4 shrink-0" />
                      {option.availabilityLabel}
                    </span>
                  )}
                </span>
                {option.key === activeApp && (
                  <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
                )}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuSeparator className="my-1 h-px bg-border" />
          <MenuItem
            value="settings"
            render={<button type="button" />}
            data-testid="app-switcher-settings"
            className={controlOption}
            onSelect={() => {
              setOpen(false)
              dispatchOpenSettingsShortcut()
            }}
          >
            <Settings aria-hidden="true" className="h-4 w-4" />
            {t('workbench.settings', '设置')}
          </MenuItem>
          <MenuItem
            value="collapse"
            render={<button type="button" />}
            data-testid="app-switcher-collapse"
            className={controlOption}
            onSelect={() => setOpen(false)}
          >
            <ChevronDown aria-hidden="true" className="h-4 w-4 rotate-180" />
            {navigationLabel}
          </MenuItem>
        </MenuContent>
      </Menu>
    </nav>
  )
}
