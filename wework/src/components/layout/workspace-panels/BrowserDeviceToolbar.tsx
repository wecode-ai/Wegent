import { RotateCw, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  BROWSER_DEVICE_PRESET_RESPONSIVE,
  BROWSER_DEVICE_PRESETS,
  BROWSER_DEVICE_VIEWPORT_ZOOM_MODES,
  type BrowserDeviceToolbarState,
  type BrowserDeviceViewportZoomMode,
} from '@/lib/browser-device-toolbar'

interface BrowserDeviceToolbarProps {
  state: BrowserDeviceToolbarState
  onPresetChange: (presetId: string) => void
  onDimensionsChange: (width: number, height: number) => void
  onRotate: () => void
  onZoomModeChange: (zoomMode: BrowserDeviceViewportZoomMode) => void
  onClose: () => void
}

function DimensionInput({
  testId,
  ariaLabel,
  value,
  onCommit,
}: {
  testId: string
  ariaLabel: string
  value: number
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  const [lastValue, setLastValue] = useState(value)
  if (value !== lastValue) {
    // Sync the draft with external changes (preset/rotate/resize) during
    // render, the React-recommended pattern for derived input state.
    setLastValue(value)
    setDraft(String(value))
  }

  const commit = () => {
    const parsed = Number.parseInt(draft, 10)
    if (Number.isFinite(parsed) && parsed > 0 && parsed !== value) {
      onCommit(parsed)
    } else {
      setDraft(String(value))
    }
  }

  return (
    <input
      data-testid={testId}
      aria-label={ariaLabel}
      inputMode="numeric"
      value={draft}
      onChange={event => setDraft(event.target.value.replace(/[^0-9]/g, ''))}
      onBlur={commit}
      onKeyDown={event => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        }
      }}
      className="h-7 w-16 rounded-md border border-border bg-surface px-2 text-center text-xs tabular-nums text-text-primary outline-none focus:border-primary"
    />
  )
}

export function BrowserDeviceToolbar({
  state,
  onPresetChange,
  onDimensionsChange,
  onRotate,
  onZoomModeChange,
  onClose,
}: BrowserDeviceToolbarProps) {
  const { t } = useTranslation('common')

  const selectClassName =
    'h-7 rounded-md border border-border bg-surface px-2 text-xs text-text-primary outline-none focus:border-primary'

  return (
    <div
      data-testid="workspace-browser-device-toolbar"
      className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-2 text-sm text-text-primary"
    >
      <select
        data-testid="workspace-browser-device-preset-select"
        aria-label={t('workbench.browser_device_presets')}
        value={state.presetId}
        onChange={event => onPresetChange(event.target.value)}
        className={`${selectClassName} min-w-[132px]`}
      >
        {BROWSER_DEVICE_PRESETS.map(preset => (
          <option key={preset.id} value={preset.id}>
            {preset.id === BROWSER_DEVICE_PRESET_RESPONSIVE
              ? `${t('workbench.browser_device_responsive')} · ${preset.width}×${preset.height}`
              : `${preset.labelKey ? t(preset.labelKey) : preset.id} · ${preset.width}×${preset.height}`}
          </option>
        ))}
      </select>
      <span className="shrink-0 text-xs text-text-muted">
        {t('workbench.browser_device_dimensions')}
      </span>
      <DimensionInput
        testId="workspace-browser-device-width-input"
        ariaLabel={t('workbench.browser_device_width')}
        value={state.width}
        onCommit={width => onDimensionsChange(width, state.height)}
      />
      <span className="text-xs text-text-muted">×</span>
      <DimensionInput
        testId="workspace-browser-device-height-input"
        ariaLabel={t('workbench.browser_device_height')}
        value={state.height}
        onCommit={height => onDimensionsChange(state.width, height)}
      />
      <button
        type="button"
        data-testid="workspace-browser-device-rotate-button"
        aria-label={t('workbench.browser_device_rotate')}
        title={t('workbench.browser_device_rotate')}
        onClick={onRotate}
        className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md px-2 text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
      >
        <RotateCw className="h-4 w-4" />
      </button>
      <select
        data-testid="workspace-browser-device-zoom-select"
        aria-label={t('workbench.browser_device_zoom')}
        value={state.zoomMode === 'fit' ? 'fit' : String(state.zoomMode)}
        onChange={event => {
          const next = event.target.value
          onZoomModeChange(next === 'fit' ? 'fit' : Number(next))
        }}
        className={`${selectClassName} min-w-[88px]`}
      >
        {BROWSER_DEVICE_VIEWPORT_ZOOM_MODES.map(mode => (
          <option key={String(mode)} value={String(mode)}>
            {mode === 'fit' ? t('workbench.browser_device_zoom_fit') : `${mode}%`}
          </option>
        ))}
      </select>
      <div className="min-w-0 flex-1" />
      <button
        type="button"
        data-testid="workspace-browser-device-close-button"
        aria-label={t('workbench.browser_device_toolbar_close')}
        title={t('workbench.browser_device_toolbar_close')}
        onClick={onClose}
        className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md px-2 text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
