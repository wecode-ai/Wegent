import { RotateCw, X } from 'lucide-react'
import { useState } from 'react'
import { MenuSelect } from '@/components/common/MenuSelect'
import { useTranslation } from '@/hooks/useTranslation'
import {
  BROWSER_DEVICE_MAX_DIMENSION,
  BROWSER_DEVICE_MIN_HEIGHT,
  BROWSER_DEVICE_MIN_WIDTH,
  BROWSER_DEVICE_PRESET_RESPONSIVE,
  BROWSER_DEVICE_PRESETS,
  clampDeviceDimension,
  deviceZoomOptions,
  type BrowserDeviceToolbarState,
} from '@/lib/browser-device-toolbar'

interface BrowserDeviceToolbarProps {
  state: BrowserDeviceToolbarState
  zoomPercent: number
  onPresetChange: (presetId: string) => void
  onDimensionsChange: (width: number, height: number) => void
  onRotate: () => void
  onZoomPercentChange: (zoomPercent: number) => void
  onClose: () => void
}

// Dimension input mirroring the Codex device toolbar: applies valid values
// live while typing, clamps on blur, Enter blurs.
function DimensionInput({
  testId,
  ariaLabel,
  min,
  value,
  onCommit,
}: {
  testId: string
  ariaLabel: string
  min: number
  value: number
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (raw: string) => {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed)) {
      onCommit(clampDeviceDimension(parsed, min))
    }
    setDraft(null)
  }

  return (
    <input
      data-testid={testId}
      aria-label={ariaLabel}
      type="number"
      min={min}
      max={BROWSER_DEVICE_MAX_DIMENSION}
      value={draft ?? String(value)}
      onFocus={() => setDraft(String(value))}
      onChange={event => {
        setDraft(event.target.value)
        const parsed = Number.parseInt(event.target.value, 10)
        if (Number.isFinite(parsed) && parsed >= min && parsed <= BROWSER_DEVICE_MAX_DIMENSION) {
          onCommit(parsed)
        }
      }}
      onBlur={event => commit(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
      className="h-6 w-[72px] rounded-lg border border-transparent bg-foreground/5 px-2 text-center text-sm font-semibold tabular-nums text-text-primary outline-none hover:bg-muted focus:border-primary focus:bg-background"
    />
  )
}

export function BrowserDeviceToolbar({
  state,
  zoomPercent,
  onPresetChange,
  onDimensionsChange,
  onRotate,
  onZoomPercentChange,
  onClose,
}: BrowserDeviceToolbarProps) {
  const { t } = useTranslation('common')

  const presetOptions = BROWSER_DEVICE_PRESETS.map(preset => ({
    value: preset.id,
    label:
      preset.id === BROWSER_DEVICE_PRESET_RESPONSIVE
        ? t('workbench.browser_device_responsive')
        : preset.labelKey
          ? t(preset.labelKey)
          : preset.id,
  }))
  const zoomOptions = deviceZoomOptions(zoomPercent).map(option => ({
    value: String(option),
    label: `${option}%`,
  }))

  return (
    <div
      data-testid="workspace-browser-device-toolbar"
      className="flex h-[34px] shrink-0 items-center gap-2 border-b border-border bg-muted px-2.5 text-sm text-text-primary"
    >
      <label
        htmlFor="workspace-browser-device-preset"
        className="max-w-28 min-w-0 shrink truncate font-medium"
      >
        {t('workbench.browser_device_dimensions')}
      </label>
      <MenuSelect
        testId="workspace-browser-device-preset-select"
        value={state.presetId}
        options={presetOptions}
        onChange={onPresetChange}
        pill
      />
      <div className="flex shrink-0 items-center gap-1">
        <DimensionInput
          testId="workspace-browser-device-width-input"
          ariaLabel={t('workbench.browser_device_width')}
          min={BROWSER_DEVICE_MIN_WIDTH}
          value={state.width}
          onCommit={width => onDimensionsChange(width, state.height)}
        />
        <span className="text-sm text-text-secondary">×</span>
        <DimensionInput
          testId="workspace-browser-device-height-input"
          ariaLabel={t('workbench.browser_device_height')}
          min={BROWSER_DEVICE_MIN_HEIGHT}
          value={state.height}
          onCommit={height => onDimensionsChange(state.width, height)}
        />
      </div>
      <button
        type="button"
        data-testid="workspace-browser-device-rotate-button"
        aria-label={t('workbench.browser_device_rotate')}
        title={t('workbench.browser_device_rotate')}
        onClick={event => {
          onRotate()
          event.currentTarget.blur()
        }}
        className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-text-secondary outline-none transition-transform hover:bg-muted hover:text-text-primary focus:bg-muted focus:text-text-primary active:rotate-90"
      >
        <RotateCw className="size-4" />
      </button>
      <MenuSelect
        testId="workspace-browser-device-zoom-select"
        value={String(zoomPercent)}
        options={zoomOptions}
        onChange={value => onZoomPercentChange(Number(value))}
        pill
      />
      <button
        type="button"
        data-testid="workspace-browser-device-close-button"
        aria-label={t('workbench.browser_device_toolbar_close')}
        title={t('workbench.browser_device_toolbar_close')}
        onClick={event => {
          onClose()
          event.currentTarget.blur()
        }}
        className="ms-auto flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-text-secondary outline-none hover:bg-muted hover:text-text-primary focus:bg-muted focus:text-text-primary"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
