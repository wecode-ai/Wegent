import { useTranslation } from '@/hooks/useTranslation'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { getUiTheme, UI_THEME_CATALOGUE } from '@wegent/collaboration/theme'
import type { CSSProperties } from 'react'
import { resolveAppearanceThemeVariables } from './applyAppearance'
import type { ResolvedAppearanceMode } from './types'
import { useAppearance } from './useAppearance'

export function ThemeSelector({ mode }: { mode: ResolvedAppearanceMode }) {
  const { t } = useTranslation('common')
  const { appearance, setAppearance } = useAppearance()
  const selectedId = mode === 'light' ? appearance.lightThemeId : appearance.darkThemeId
  const selected = getUiTheme(selectedId, mode)
  const themes = UI_THEME_CATALOGUE.filter(theme => theme.variants[mode])
  const label =
    mode === 'light'
      ? t('workbench.appearance_light_theme', '浅色配色')
      : t('workbench.appearance_dark_theme', '深色配色')
  const previewStyle = {
    ...resolveAppearanceThemeVariables(appearance, mode),
    colorScheme: mode,
  } as CSSProperties

  return (
    <div className="min-w-0 space-y-3">
      <label className="grid gap-2 text-sm text-text-primary">
        <span>{label}</span>
        <SelectRoot
          value={normalizeSelectValue(selectedId)}
          onValueChange={selectedValue => {
            if (selectedValue !== null)
              return setAppearance({
                [mode === 'light' ? 'lightThemeId' : 'darkThemeId']: selectedValue,
                themeOverrides: { [mode]: {} },
              })
          }}
        >
          <SelectTrigger
            aria-label={label}
            className="wework-native-select h-11 w-full text-base"
            data-testid={`appearance-theme-select-${mode}`}
          />
          <SelectContent>
            {themes.map(theme => (
              <SelectItem key={theme.id} value={String(theme.id)}>
                {theme.label}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectRoot>
      </label>
      <div
        aria-hidden="true"
        className="overflow-hidden rounded-lg border border-border bg-background text-text-primary"
        data-testid={`appearance-theme-preview-${mode}`}
        data-theme={mode}
        style={previewStyle}
      >
        <div className="flex items-center justify-between border-b border-border bg-surface px-3 py-2">
          <span className="text-sm font-medium">{selected.label}</span>
          <div className="flex gap-1">
            {['keyword', 'string', 'number', 'function'].map(name => (
              <span
                key={name}
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: `rgb(var(--color-syntax-${name}))` }}
              />
            ))}
          </div>
        </div>
        <div className="flex min-h-[120px]">
          <div className="w-20 shrink-0 space-y-2 bg-sidebar p-3">
            <div className="h-2 w-full rounded bg-sidebar-text-muted/40" />
            <div className="h-6 rounded bg-sidebar-active" />
            <div className="h-2 w-3/4 rounded bg-sidebar-text-muted/30" />
          </div>
          <div className="min-w-0 flex-1 space-y-3 p-3">
            <div className="h-2 w-2/3 rounded bg-text-primary/60" />
            <div className="h-2 w-full rounded bg-text-muted/30" />
            <pre className="overflow-hidden text-code">
              <code>
                <span style={{ color: 'rgb(var(--color-syntax-keyword))' }}>const </span>
                <span style={{ color: 'rgb(var(--color-syntax-variable))' }}>theme </span>
                <span style={{ color: 'rgb(var(--color-syntax-operator))' }}>= </span>
                <span style={{ color: 'rgb(var(--color-syntax-string))' }}>'{selected.label}'</span>
              </code>
            </pre>
            <div className="h-5 w-10 rounded bg-primary" />
          </div>
        </div>
      </div>
    </div>
  )
}
