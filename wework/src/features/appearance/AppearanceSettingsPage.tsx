import {
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSwitch,
} from '@/components/settings/settings-ui'
import { useTranslation } from '@/hooks/useTranslation'
import { track } from '@/telemetry/client'
import { Checkbox } from '@wegent/collaboration/controls/Checkbox'
import { RangeSlider } from '@wegent/collaboration/controls/RangeSlider'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Image, Monitor, Moon, RotateCcw, Sun, Trash2 } from 'lucide-react'
import { useState } from 'react'
import {
  removeWorkbenchBackground,
  selectWorkbenchBackground,
  type WorkbenchBackgroundSlot,
} from './backgroundImage'
import { ThemeSelector } from './ThemeSelector'
import type { AppearanceMode, WorkbenchBackgroundConfig } from './types'
import {
  MAX_CODE_FONT_SIZE,
  MAX_UI_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_UI_FONT_SIZE,
  normalizeFontSize,
} from './typography'
import { useAppearance } from './useAppearance'
import { WorkbenchBackgroundPreview } from './WorkbenchBackgroundPreview'

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
      <ControlInput
        density="compact"
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
        className="w-16 text-right wework:keyboard:focus:border-blue-500 wework:keyboard:focus:ring-blue-500/20"
      />
      <span className="text-sm text-text-secondary">px</span>
    </div>
  )
}

export function AppearanceSettingsPage() {
  const { t } = useTranslation('common')
  const { appearance, resolvedMode, setAppearance, resetAppearance } = useAppearance()
  const [backgroundBusy, setBackgroundBusy] = useState(false)
  const [backgroundError, setBackgroundError] = useState<string | null>(null)
  const commonBackground: WorkbenchBackgroundConfig = {
    imagePath: appearance.backgroundImagePath,
    visibility: appearance.backgroundVisibility,
    blur: appearance.backgroundBlur,
    inMain: appearance.backgroundInMain,
    inSidebar: appearance.backgroundInSidebar,
    inTopBar: appearance.backgroundInTopBar,
  }
  const backgroundEditors = appearance.separateBackgroundsByTheme
    ? [
        {
          slot: 'light' as const,
          label: t('workbench.appearance_background_light', '浅色模式背景'),
          config: appearance.lightBackground,
        },
        {
          slot: 'dark' as const,
          label: t('workbench.appearance_background_dark', '暗色模式背景'),
          config: appearance.darkBackground,
        },
      ]
    : [
        {
          slot: 'common' as const,
          label: t('workbench.appearance_background_common', '所有模式背景'),
          config: commonBackground,
        },
      ]
  const hasBackground = Boolean(
    appearance.backgroundImagePath ||
    appearance.lightBackground.imagePath ||
    appearance.darkBackground.imagePath
  )

  const updateBackground = (
    slot: WorkbenchBackgroundSlot,
    update: Partial<WorkbenchBackgroundConfig>
  ) => {
    if (slot === 'light') {
      setAppearance({ lightBackground: update })
    } else if (slot === 'dark') {
      setAppearance({ darkBackground: update })
    } else {
      setAppearance({
        backgroundImagePath:
          update.imagePath === undefined ? appearance.backgroundImagePath : update.imagePath,
        backgroundVisibility: update.visibility ?? appearance.backgroundVisibility,
        backgroundBlur: update.blur ?? appearance.backgroundBlur,
        backgroundInMain: update.inMain ?? appearance.backgroundInMain,
        backgroundInSidebar: update.inSidebar ?? appearance.backgroundInSidebar,
        backgroundInTopBar: update.inTopBar ?? appearance.backgroundInTopBar,
      })
    }
  }

  const selectBackground = async (slot: WorkbenchBackgroundSlot) => {
    setBackgroundBusy(true)
    setBackgroundError(null)
    try {
      const backgroundImagePath = await selectWorkbenchBackground(slot)
      if (backgroundImagePath) {
        updateBackground(slot, { imagePath: backgroundImagePath })
      }
    } catch {
      setBackgroundError(
        t('workbench.appearance_background_error', '无法保存背景图，请选择其他图片后重试')
      )
    } finally {
      setBackgroundBusy(false)
    }
  }

  const removeBackground = async (slot: WorkbenchBackgroundSlot) => {
    setBackgroundBusy(true)
    setBackgroundError(null)
    try {
      await removeWorkbenchBackground(slot)
      updateBackground(slot, { imagePath: null })
    } catch {
      setBackgroundError(t('workbench.appearance_background_remove_error', '无法移除背景图'))
    } finally {
      setBackgroundBusy(false)
    }
  }

  const setSeparateBackgrounds = (separateBackgroundsByTheme: boolean) => {
    if (separateBackgroundsByTheme && !appearance.themeBackgroundsInitialized) {
      const inheritedSettings = {
        visibility: commonBackground.visibility,
        blur: commonBackground.blur,
        inMain: commonBackground.inMain,
        inSidebar: commonBackground.inSidebar,
        inTopBar: commonBackground.inTopBar,
      }
      setAppearance({
        separateBackgroundsByTheme: true,
        themeBackgroundsInitialized: true,
        lightBackground: inheritedSettings,
        darkBackground: inheritedSettings,
      })
      return
    }
    setAppearance({ separateBackgroundsByTheme })
  }

  const reset = async () => {
    if (hasBackground) {
      try {
        await removeWorkbenchBackground()
      } catch {
        setBackgroundError(t('workbench.appearance_background_remove_error', '无法移除背景图'))
        return
      }
    }
    resetAppearance()
  }

  return (
    <SettingsPage data-testid="appearance-settings-page">
      <SettingsPageHeader
        title={t('workbench.appearance_title', '外观')}
        description={t('workbench.appearance_subtitle', '调整 Wework 的主题、颜色和字体')}
        actions={
          <ControlButton
            variant="outline"
            size="sm"
            type="button"
            data-testid="appearance-reset-button"
            onClick={() => void reset()}
          >
            <RotateCcw className="h-4 w-4" />
            {t('workbench.appearance_reset', '恢复默认')}
          </ControlButton>
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
              <ControlButton
                variant="unstyled"
                key={item.mode}
                type="button"
                data-testid={`appearance-mode-${item.mode}`}
                aria-pressed={active}
                onClick={() => {
                  setAppearance({ mode: item.mode })
                  track('setting_changed', { setting: 'appearance_mode', value: item.mode })
                }}
                className={[
                  'flex h-11 items-center justify-center gap-2 rounded-md border text-sm font-medium transition-colors',
                  active
                    ? 'border-text-primary bg-text-primary text-background'
                    : 'border-border bg-background text-text-primary hover:bg-muted',
                ].join(' ')}
              >
                <Icon className="h-4 w-4" />
                {t(`workbench.${item.labelKey}`, item.fallback)}
              </ControlButton>
            )
          })}
        </div>
        <div
          className="grid gap-4 border-t border-border p-4 md:grid-cols-2"
          data-testid="appearance-theme-catalogue"
        >
          <ThemeSelector mode="light" />
          <ThemeSelector mode="dark" />
          <p className="text-sm text-text-secondary md:col-span-2">
            {t(
              'workbench.appearance_theme_selection_description',
              '分别选择浅色和深色配色；跟随系统时自动切换。选择配色会恢复该配色的强调色。'
            )}
          </p>
        </div>
        <div className="border-t border-border">
          <div>
            <SettingsRow
              label={t('workbench.appearance_accent', '强调色')}
              children={
                <label className="flex h-9 items-center gap-2 rounded-md border border-border bg-background px-2">
                  <ControlInput
                    appearance="plain"
                    data-testid="appearance-accent-input"
                    type="color"
                    value={appearance.accentColor}
                    onChange={event => setAppearance({ accentColor: event.target.value })}
                    onBlur={() =>
                      track('setting_changed', {
                        setting: 'accent_color',
                        value: appearance.accentColor,
                      })
                    }
                    className="h-5 w-5 cursor-pointer"
                  />
                  <span className="w-20 font-mono text-xs text-text-secondary">
                    {appearance.accentColor.toUpperCase()}
                  </span>
                </label>
              }
            />
            <SettingsRow
              label={t('workbench.appearance_accent_reset', '恢复配色强调色')}
              children={
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="appearance-accent-reset-button"
                  onClick={() =>
                    setAppearance({
                      themeOverrides: {
                        [resolvedMode]: {
                          palette: appearance.themeOverrides[resolvedMode].palette,
                        },
                      },
                    })
                  }
                  disabled={!appearance.themeOverrides[resolvedMode].accentColor}
                  className="inline-flex h-9 items-center rounded-md px-3 text-sm text-text-primary hover:bg-muted disabled:opacity-40"
                >
                  {t('workbench.appearance_accent_reset_action', '恢复')}
                </ControlButton>
              }
            />
            <SettingsRow
              label={t('workbench.appearance_sidebar_translucent', '半透明侧边栏')}
              children={
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
              children={
                <div className="flex items-center gap-3">
                  <RangeSlider
                    min={0}
                    max={100}
                    value={appearance.contrast}
                    onChange={value => setAppearance({ contrast: Number(value) })}
                    label={t('workbench.appearance_contrast', '对比度')}
                    testId="appearance-contrast-slider"
                    inputTestId="appearance-contrast-slider"
                    className="w-36"
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
            {t('workbench.appearance_background', '工作台背景')}
          </h2>
        </div>
        <SettingsRow
          label={t('workbench.appearance_background_separate', '区分浅色与暗色模式')}
          description={t(
            'workbench.appearance_background_separate_description',
            '为浅色和暗色主题分别设置背景图片'
          )}
          children={
            <SettingsSwitch
              data-testid="appearance-background-separate-toggle"
              checked={appearance.separateBackgroundsByTheme}
              onCheckedChange={setSeparateBackgrounds}
              aria-label={t('workbench.appearance_background_separate', '区分浅色与暗色模式')}
            />
          }
        />
        <div className="grid gap-4 p-4">
          {backgroundEditors.map(editor => {
            const displayConfig = {
              ...editor.config,
              imagePath:
                editor.slot === 'common'
                  ? editor.config.imagePath
                  : (editor.config.imagePath ?? appearance.backgroundImagePath),
            }
            const testIdSuffix = editor.slot === 'common' ? '' : `-${editor.slot}`
            const editorHasBackground = Boolean(displayConfig.imagePath)
            return (
              <div
                key={editor.slot}
                data-testid={`appearance-background-editor-${editor.slot}`}
                className="grid gap-4 rounded-lg border border-border p-3 md:grid-cols-[minmax(0,1fr)_minmax(16rem,1fr)]"
              >
                <div className="grid content-start gap-2">
                  <span className="text-sm font-medium text-text-primary">{editor.label}</span>
                  <WorkbenchBackgroundPreview
                    imagePath={displayConfig.imagePath}
                    visibility={displayConfig.visibility}
                    blur={displayConfig.blur}
                    testIdSuffix={testIdSuffix}
                  />
                  <div className="flex flex-wrap gap-2">
                    <ControlButton
                      variant="primary"
                      size="sm"
                      type="button"
                      data-testid={`appearance-background-select-button${testIdSuffix}`}
                      disabled={backgroundBusy}
                      onClick={() => void selectBackground(editor.slot)}
                    >
                      <Image className="h-4 w-4" />
                      {t('workbench.appearance_background_select', '选择图片')}
                    </ControlButton>
                    {editor.config.imagePath && (
                      <ControlButton
                        type="button"
                        data-testid={`appearance-background-remove-button${testIdSuffix}`}
                        disabled={backgroundBusy}
                        onClick={() => void removeBackground(editor.slot)}
                        variant="destructive-ghost"
                        size="sm"
                      >
                        <Trash2 className="h-4 w-4" />
                        {t('workbench.appearance_background_remove', '移除')}
                      </ControlButton>
                    )}
                  </div>
                </div>
                <div className="flex flex-col justify-center gap-4">
                  <label className="grid gap-2 text-sm text-text-secondary">
                    <span className="flex justify-between">
                      {t('workbench.appearance_background_visibility', '背景可见度')}
                      <span>{editor.config.visibility}</span>
                    </span>
                    <RangeSlider
                      min={0}
                      max={100}
                      value={editor.config.visibility}
                      disabled={!editorHasBackground}
                      onChange={value =>
                        updateBackground(editor.slot, {
                          visibility: Number(value),
                        })
                      }
                      label={t('workbench.appearance_background_visibility', '背景可见度')}
                      testId={`appearance-background-visibility-slider${testIdSuffix}`}
                      inputTestId={`appearance-background-visibility-slider${testIdSuffix}`}
                      className="w-36"
                    />
                  </label>
                  <label className="grid gap-2 text-sm text-text-secondary">
                    <span className="flex justify-between">
                      {t('workbench.appearance_background_blur', '背景模糊')}
                      <span>{editor.config.blur}px</span>
                    </span>
                    <RangeSlider
                      min={0}
                      max={20}
                      value={editor.config.blur}
                      disabled={!editorHasBackground}
                      onChange={value => updateBackground(editor.slot, { blur: Number(value) })}
                      label={t('workbench.appearance_background_blur', '背景模糊')}
                      testId={`appearance-background-blur-slider${testIdSuffix}`}
                      inputTestId={`appearance-background-blur-slider${testIdSuffix}`}
                      className="w-36"
                    />
                  </label>
                  <fieldset className="grid gap-2">
                    <legend className="mb-1 text-sm text-text-secondary">
                      {t('workbench.appearance_background_areas', '显示区域')}
                    </legend>
                    {[
                      {
                        key: 'main',
                        label: t('workbench.appearance_background_area_main', '主区域'),
                        checked: editor.config.inMain,
                        update: (checked: boolean) =>
                          updateBackground(editor.slot, { inMain: checked }),
                      },
                      {
                        key: 'sidebar',
                        label: t('workbench.appearance_background_area_sidebar', '侧边栏'),
                        checked: editor.config.inSidebar,
                        update: (checked: boolean) =>
                          updateBackground(editor.slot, { inSidebar: checked }),
                      },
                      {
                        key: 'topbar',
                        label: t('workbench.appearance_background_area_topbar', '顶部栏'),
                        checked: editor.config.inTopBar,
                        update: (checked: boolean) =>
                          updateBackground(editor.slot, { inTopBar: checked }),
                      },
                    ].map(area => (
                      <label
                        key={area.key}
                        className="flex items-center gap-2 text-sm text-text-primary"
                      >
                        <Checkbox
                          data-testid={`appearance-background-area-${area.key}${testIdSuffix}`}
                          checked={area.checked}
                          disabled={!editorHasBackground}
                          onCheckedChange={checked => area.update(checked === true)}
                          className="h-4 w-4 accent-[rgb(var(--color-text-primary))]"
                        />
                        {area.label}
                      </label>
                    ))}
                  </fieldset>
                </div>
              </div>
            )
          })}
          {backgroundError && (
            <p
              data-testid="appearance-background-error"
              className="text-sm text-destructive wework:text-red-500"
            >
              {backgroundError}
            </p>
          )}
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
          children={
            <ControlInput
              data-testid="appearance-ui-font-input"
              value={appearance.uiFont}
              onChange={event => setAppearance({ uiFont: event.target.value })}
              className="h-9 w-[min(24rem,52vw)] focus:border-text-primary"
            />
          }
        />
        <SettingsRow
          label={t('workbench.appearance_code_font', '代码字体')}
          children={
            <ControlInput
              data-testid="appearance-code-font-input"
              value={appearance.codeFont}
              onChange={event => setAppearance({ codeFont: event.target.value })}
              className="h-9 w-[min(24rem,52vw)] font-mono focus:border-text-primary"
            />
          }
        />
        <SettingsRow
          label={t('workbench.appearance_ui_font_size', 'UI 字号')}
          description={t(
            'workbench.appearance_ui_font_size_description',
            '调整 Wework 界面使用的基础字号'
          )}
          children={
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
          children={
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
