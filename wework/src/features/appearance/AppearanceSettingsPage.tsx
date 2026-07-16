import { Monitor, Moon, RotateCcw, Sun } from 'lucide-react'
import {
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSwitch,
} from '@/components/settings/settings-ui'
import { useTranslation } from '@/hooks/useTranslation'
import { useAppearance } from './useAppearance'
import type { AppearanceMode } from './types'
import {
  MAX_CODE_FONT_SIZE,
  MAX_UI_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_UI_FONT_SIZE,
  normalizeFontSize,
} from './typography'

const themeModes: Array<{
  mode: AppearanceMode
  icon: typeof Sun
  labelKey: string
  fallback: string
}> = [
  { mode: 'light', icon: Sun, labelKey: 'appearance_light', fallback: '浅色' },
  { mode: 'dark', icon: Moon, labelKey: 'appearance_dark', fallback: '深色' },
  { mode: 'system', icon: Monitor, labelKey: 'appearance_system', fallback: '系统' },
]

interface FontSizeControlProps {
  testId: string
  ariaLabel: string
  value: number
  minimum: number
  maximum: number
  onCommit: (value: number) => void
}

function FontSizeControl({
  testId,
  ariaLabel,
  value,
  minimum,
  maximum,
  onCommit,
}: FontSizeControlProps) {
  const commit = (input: HTMLInputElement) => {
    const parsedValue = Number.parseFloat(input.value)
    if (Number.isNaN(parsedValue)) {
      input.value = String(value)
      return
    }

    const nextValue = normalizeFontSize(parsedValue, value, minimum, maximum)
    input.value = String(nextValue)
    if (nextValue !== value) onCommit(nextValue)
  }

  return (
    <div className="flex items-center gap-2">
      <input
        key={value}
        data-testid={testId}
        aria-label={ariaLabel}
        type="number"
        min={minimum}
        max={maximum}
        step={1}
        defaultValue={value}
        onBlur={event => commit(event.currentTarget)}
        onKeyDown={event => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          commit(event.currentTarget)
        }}
        className="h-8 w-16 rounded-lg border border-border bg-background px-2 text-right text-sm text-text-primary shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
      />
      <span className="text-sm text-text-secondary">px</span>
    </div>
  )
}

export function AppearanceSettingsPage() {
  const { t } = useTranslation('common')
  const { appearance, resolvedMode, setAppearance, resetAppearance } = useAppearance()

  return (
    <SettingsPage data-testid="appearance-settings-page">
      <SettingsPageHeader
        title={t('workbench.appearance_title', '外观')}
        description={t('workbench.appearance_subtitle', '调整 Wework 的主题、颜色和字体')}
        actions={
          <button
            type="button"
            data-testid="appearance-reset-button"
            onClick={resetAppearance}
            className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-text-primary hover:bg-muted"
          >
            <RotateCcw className="h-4 w-4" />
            {t('workbench.appearance_reset', '恢复默认')}
          </button>
        }
      />

      <section className="overflow-hidden rounded-lg border border-border bg-background">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text-primary">
            {t('workbench.appearance_theme', '主题')}
          </h2>
        </div>
        <div className="grid grid-cols-3 gap-2 p-3">
          {themeModes.map(item => {
            const Icon = item.icon
            const active = appearance.mode === item.mode

            return (
              <button
                key={item.mode}
                type="button"
                data-testid={`appearance-mode-${item.mode}`}
                onClick={() => setAppearance({ mode: item.mode })}
                className={[
                  'flex h-11 items-center justify-center gap-2 rounded-md border text-sm font-medium transition-colors',
                  active
                    ? 'border-text-primary bg-text-primary text-background'
                    : 'border-border bg-background text-text-primary hover:bg-muted',
                ].join(' ')}
              >
                <Icon className="h-4 w-4" />
                {t(`workbench.${item.labelKey}`, item.fallback)}
              </button>
            )
          })}
        </div>
        <div className="grid gap-3 border-t border-border p-4 md:grid-cols-2">
          <div className="overflow-hidden rounded-lg border border-border bg-background">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="text-xs font-medium text-text-secondary">
                {t('workbench.appearance_preview', '预览')}
              </span>
              <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-text-secondary">
                {resolvedMode}
              </span>
            </div>
            <div className="flex min-h-[132px]">
              <div className="w-28 bg-sidebar p-3">
                <div className="mb-3 h-3 w-16 rounded bg-text-muted/30" />
                <div className="h-7 rounded bg-sidebar-active" />
                <div className="mt-2 h-7 rounded bg-sidebar-hover" />
              </div>
              <div className="flex-1 space-y-3 bg-background p-4">
                <div className="h-4 w-32 rounded bg-text-primary/20" />
                <div className="h-3 w-full rounded bg-text-muted/30" />
                <div className="h-3 w-3/4 rounded bg-text-muted/25" />
                <button
                  type="button"
                  className="h-8 rounded-md bg-text-primary px-3 text-xs font-medium text-background"
                >
                  {t('workbench.appearance_preview_action', '操作')}
                </button>
              </div>
            </div>
          </div>
          <div className="overflow-hidden rounded-lg border border-border bg-background">
            <SettingsRow
              label={t('workbench.appearance_accent', '强调色')}
              control={
                <label className="flex h-9 items-center gap-2 rounded-md border border-border bg-background px-2">
                  <input
                    data-testid="appearance-accent-input"
                    type="color"
                    value={appearance.accentColor}
                    onChange={event => setAppearance({ accentColor: event.target.value })}
                    className="h-5 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
                  />
                  <span className="w-20 font-mono text-xs text-text-secondary">
                    {appearance.accentColor.toUpperCase()}
                  </span>
                </label>
              }
            />
            <SettingsRow
              label={t('workbench.appearance_sidebar_translucent', '半透明侧边栏')}
              control={
                <SettingsSwitch
                  data-testid="appearance-sidebar-translucent-toggle"
                  checked={appearance.sidebarTranslucent}
                  onCheckedChange={sidebarTranslucent => setAppearance({ sidebarTranslucent })}
                  aria-label={t('workbench.appearance_sidebar_translucent', '半透明侧边栏')}
                />
              }
            />
            <SettingsRow
              label={t('workbench.appearance_contrast', '对比度')}
              control={
                <div className="flex items-center gap-3">
                  <input
                    data-testid="appearance-contrast-slider"
                    type="range"
                    min="0"
                    max="100"
                    value={appearance.contrast}
                    onChange={event => setAppearance({ contrast: Number(event.target.value) })}
                    className="w-36 accent-[rgb(var(--color-text-primary))]"
                  />
                  <span className="w-8 text-right text-sm text-text-secondary">
                    {appearance.contrast}
                  </span>
                </div>
              }
            />
          </div>
        </div>
      </section>

      <section className="mt-4 overflow-hidden rounded-lg border border-border bg-background">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text-primary">
            {t('workbench.appearance_fonts', '字体')}
          </h2>
        </div>
        <SettingsRow
          label={t('workbench.appearance_ui_font', 'UI 字体')}
          control={
            <input
              data-testid="appearance-ui-font-input"
              value={appearance.uiFont}
              onChange={event => setAppearance({ uiFont: event.target.value })}
              className="h-9 w-[min(24rem,52vw)] rounded-md border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-text-primary"
            />
          }
        />
        <SettingsRow
          label={t('workbench.appearance_code_font', '代码字体')}
          control={
            <input
              data-testid="appearance-code-font-input"
              value={appearance.codeFont}
              onChange={event => setAppearance({ codeFont: event.target.value })}
              className="h-9 w-[min(24rem,52vw)] rounded-md border border-border bg-background px-3 font-mono text-sm text-text-primary outline-none focus:border-text-primary"
            />
          }
        />
        <SettingsRow
          label={t('workbench.appearance_ui_font_size', 'UI 字号')}
          description={t(
            'workbench.appearance_ui_font_size_description',
            '调整 Wework 界面使用的基础字号'
          )}
          control={
            <FontSizeControl
              testId="appearance-ui-font-size-input"
              ariaLabel={t('workbench.appearance_ui_font_size', 'UI 字号')}
              value={appearance.uiFontSize}
              minimum={MIN_UI_FONT_SIZE}
              maximum={MAX_UI_FONT_SIZE}
              onCommit={uiFontSize => setAppearance({ uiFontSize })}
            />
          }
        />
        <SettingsRow
          label={t('workbench.appearance_code_font_size', '代码字号')}
          description={t(
            'workbench.appearance_code_font_size_description',
            '调整聊天、diff、编辑器和终端中的代码字号'
          )}
          control={
            <FontSizeControl
              testId="appearance-code-font-size-input"
              ariaLabel={t('workbench.appearance_code_font_size', '代码字号')}
              value={appearance.codeFontSize}
              minimum={MIN_CODE_FONT_SIZE}
              maximum={MAX_CODE_FONT_SIZE}
              onCommit={codeFontSize => setAppearance({ codeFontSize })}
            />
          }
        />
      </section>
    </SettingsPage>
  )
}
