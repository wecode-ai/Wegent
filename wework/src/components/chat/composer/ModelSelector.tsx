import { Check, Cloud, LogIn, Plus, Search, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'
import { useConfiguredKeybinding } from '@/hooks/useConfiguredKeybinding'
import { useEmbeddedBrowserOcclusion } from '@/hooks/useEmbeddedBrowserOcclusion'
import { useIsMobile } from '@/hooks/useIsMobile'
import {
  type ModelControlConfig,
  getControlsForModel,
  getModelDisplayLabel,
  getSelectedModelDisplayLabel,
  groupModelsByFamily,
  inferModelFamily,
  isModelInterfaceModel,
  normalizeModelOptionValue,
} from '@/lib/model-ui'
import { navigateTo } from '@/lib/navigation'
import { cn } from '@/lib/utils'
import { TOGGLE_MODEL_SELECTOR_COMMAND } from '@/lib/keybindings'
import type { UnifiedModel } from '@/types/api'
import { FastModeIcon } from './FastModeIcon'
import { ModelAdvancedHeader } from './ModelAdvancedHeader'
import { ModelAutomaticReasoningOption } from './ModelAutomaticReasoningOption'
import { ModelSelectorFlyout } from './ModelSelectorFlyout'
import { ModelSelectorMenuRow } from './ModelSelectorMenuRow'
import { ModelPowerSlider } from './ModelPowerSlider'
import { ModelResetDefaultRow } from './ModelResetDefaultRow'
import { ModelSelectorTrigger } from './ModelSelectorTrigger'
import { ReasoningSlider } from './ReasoningSlider'
import type { ModelSelectorCloseReason, ModelSelectorProps } from './model-selector-types'
import {
  handleMobileModelSelectorDialogKeyDown,
  useMobileModelSelectorFocus,
} from './model-selector-mobile-utils'
import {
  getDesktopModelSelectorCollisionPadding,
  MODEL_SELECTOR_VIEWPORT_MARGIN,
  MODEL_SELECTOR_VIEWPORT_TOP,
} from './model-selector-layout'
import {
  MODEL_SELECTOR_VIEW_CHANGED_EVENT,
  readModelSelectorPowerViewPreference,
  writeModelSelectorPowerViewPreference,
} from './model-selector-view-preference'
import {
  CODEX_DEFAULT_REASONING_EFFORT,
  CODEX_DEFAULT_SPEED,
  desktopFastModeState,
  desktopModelControl,
  findCodexDefaultModel,
  getCodexModelPowerSettings,
  isSelectedPowerSetting,
  isVisibleModelSelectorControl,
  modelCompatibilityDisabledMessage,
  selectedControlOption,
} from './model-selector-utils'
import styles from './ModelSelector.module.css'

const MAIN_MENU_WIDTH = 224
const MODEL_SUBMENU_WIDTH = 280
const CONTROL_SUBMENU_MIN_WIDTH = 180
const SPEED_SUBMENU_WIDTH = 233
const MAIN_MENU_TRIGGER_GAP = 8
const MAIN_MENU_MAX_HEIGHT = 608
const DESKTOP_HIDDEN_CONTROL_IDS = new Set(['collaborationMode'])
type DesktopSubmenuTarget = { type: 'models' } | { type: 'control'; id: string } | { type: 'none' }

function getDesktopViewportRightBoundary(): number {
  const shell = document.getElementById('right-workspace-panel-shell')
  if (shell && shell.getAttribute('aria-hidden') !== 'true') {
    const rect = shell.getBoundingClientRect()
    if (rect.width > 0) return Math.round(rect.left)
  }
  return window.innerWidth
}

function isDesktopSubmenuTargetActive(
  current: DesktopSubmenuTarget | null,
  target: DesktopSubmenuTarget
): boolean {
  if (current?.type !== target.type) return false
  if (current.type === 'control' && target.type === 'control') {
    return current.id === target.id
  }
  return true
}

function isCloudModel(model: UnifiedModel): boolean {
  return model.provider !== 'local'
}

function codexProviderId(model: UnifiedModel | null): string | undefined {
  const providerId = model?.config?.codexProviderId
  return typeof providerId === 'string' ? providerId : undefined
}

export function ModelSelector({
  models,
  selectedModel,
  selectedModelOptions,
  nextTurn = false,
  disabled,
  onSelectModel,
  onSelectModelAndOptions,
  onSelectModelOption,
  onBlockedModelSelect,
  onOpenChange,
  openSignal,
  menuPlacement = 'above',
  buttonClassName = '',
  menuClassName = '',
  maxClosedWidth,
}: ModelSelectorProps) {
  const { t } = useTranslation('common')
  const isMobile = useIsMobile()
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const desktopMenuWrapperRef = useRef<HTMLDivElement>(null)
  const menuPanelRef = useRef<HTMLDivElement>(null)
  const mobileMenuRef = useRef<HTMLDivElement>(null)
  const mobileCloseButtonRef = useRef<HTMLButtonElement>(null)
  const handledOpenSignalRef = useRef<number | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [closeReason, setCloseReason] = useState<ModelSelectorCloseReason>('dismiss')
  const [mobileQuery, setMobileQuery] = useState('')
  const [desktopMenuTop, setDesktopMenuTop] = useState(0)
  const [desktopMenuLeft, setDesktopMenuLeft] = useState(0)
  const [desktopMenuMaxHeight, setDesktopMenuMaxHeight] = useState(MAIN_MENU_MAX_HEIGHT)
  const [activeDesktopSubmenu, setActiveDesktopSubmenu] = useState<DesktopSubmenuTarget | null>(
    null
  )
  const [advancedOpen, setAdvancedOpen] = useState(readModelSelectorPowerViewPreference)
  const [powerSliderInteracting, setPowerSliderInteracting] = useState(false)
  const modelSelectorShortcut = useConfiguredKeybinding(TOGGLE_MODEL_SELECTOR_COMMAND)
  const reportedOpenRef = useRef(open)
  const desktopFlyoutOpen =
    open && !isMobile && activeDesktopSubmenu !== null && activeDesktopSubmenu.type !== 'none'

  useEmbeddedBrowserOcclusion('model-selector-flyout', desktopFlyoutOpen)

  useEffect(() => {
    if (reportedOpenRef.current === open) return
    reportedOpenRef.current = open
    onOpenChange?.(open, open ? undefined : closeReason)
  }, [closeReason, onOpenChange, open])
  const familyGroups = useMemo(() => groupModelsByFamily(models), [models])
  const selectedFamily = selectedModel
    ? inferModelFamily(selectedModel)
    : familyGroups[0]?.config.id
  const [activeFamilyId, setActiveFamilyId] = useState(selectedFamily ?? '')
  const displayedFamilyId = activeFamilyId || selectedFamily || familyGroups[0]?.config.id || ''
  const activeGroup =
    familyGroups.find(group => group.config.id === displayedFamilyId) ?? familyGroups[0]

  useEffect(() => {
    if (!openSignal || disabled || open) return
    if (handledOpenSignalRef.current === openSignal) return

    handledOpenSignalRef.current = openSignal
    buttonRef.current?.click()
  }, [disabled, open, openSignal])

  const closeMenu = useCallback(
    (reason: ModelSelectorCloseReason = 'dismiss') => {
      setCloseReason(reason)
      setOpen(false)
      setMobileQuery('')
      setActiveDesktopSubmenu(null)
      setPowerSliderInteracting(false)
    },
    [setActiveDesktopSubmenu, setCloseReason, setMobileQuery, setOpen, setPowerSliderInteracting]
  )
  const openModelSettings = useCallback(() => {
    closeMenu()
    navigateTo('/settings/personal/models')
  }, [closeMenu])
  const openCloudConnectionSettings = useCallback(() => {
    closeMenu()
    navigateTo('/settings/connections')
  }, [closeMenu])
  const handleSelectModelOption = useCallback(
    (optionId: string, value: string) => {
      onSelectModelOption(optionId, value)
      if (isMobile) {
        closeMenu()
      }
    },
    [closeMenu, isMobile, onSelectModelOption]
  )
  const handleSelectModel = useCallback(
    (model: UnifiedModel | null) => {
      const selectionApplied = onSelectModel(model)
      if (isMobile && selectionApplied !== false) {
        closeMenu()
      }
      return selectionApplied
    },
    [closeMenu, isMobile, onSelectModel]
  )
  const updateDesktopMenuLayout = useCallback(() => {
    const button = buttonRef.current
    const menuPanel = menuPanelRef.current
    if (!button || !menuPanel) return

    const viewportTop = MODEL_SELECTOR_VIEWPORT_TOP
    const viewportBottom = window.innerHeight - MODEL_SELECTOR_VIEWPORT_MARGIN
    const maxAvailableHeight = Math.max(0, viewportBottom - viewportTop)
    const measuredHeight = menuPanel.getBoundingClientRect().height
    const contentHeight = menuPanel.scrollHeight
    const naturalHeight = Math.max(measuredHeight, contentHeight) || MAIN_MENU_MAX_HEIGHT
    const menuHeight = Math.min(MAIN_MENU_MAX_HEIGHT, maxAvailableHeight, naturalHeight)
    const buttonRect = button.getBoundingClientRect()
    const preferredTop =
      menuPlacement === 'below'
        ? buttonRect.bottom + MAIN_MENU_TRIGGER_GAP
        : buttonRect.top - MAIN_MENU_TRIGGER_GAP - menuHeight
    const maxTop = viewportBottom - menuHeight
    const clampedTop = Math.round(Math.max(viewportTop, Math.min(preferredTop, maxTop)))
    const menuWidth = menuPanel.getBoundingClientRect().width || MAIN_MENU_WIDTH
    const viewportRight = getDesktopViewportRightBoundary()
    const maxLeft = viewportRight - MODEL_SELECTOR_VIEWPORT_MARGIN - menuWidth
    const preferredLeft = buttonRect.right - menuWidth
    const clampedLeft = Math.round(
      Math.max(MODEL_SELECTOR_VIEWPORT_MARGIN, Math.min(preferredLeft, maxLeft))
    )

    setDesktopMenuTop(clampedTop)
    setDesktopMenuLeft(clampedLeft)
    setDesktopMenuMaxHeight(menuHeight)
  }, [menuPlacement])
  const activateControl = useCallback(
    (controlId: string) => {
      setActiveDesktopSubmenu(current =>
        current?.type === 'control' && current.id === controlId
          ? current
          : { type: 'control', id: controlId }
      )
    },
    [setActiveDesktopSubmenu]
  )
  const activateModels = useCallback(() => {
    setActiveDesktopSubmenu(current => (current?.type === 'models' ? current : { type: 'models' }))
  }, [setActiveDesktopSubmenu])
  const clearDesktopSubmenu = useCallback(() => {
    setActiveDesktopSubmenu(current => (current?.type === 'none' ? current : { type: 'none' }))
  }, [setActiveDesktopSubmenu])
  const setDesktopSubmenuOpen = useCallback(
    (target: DesktopSubmenuTarget, nextOpen: boolean) => {
      setActiveDesktopSubmenu(current => {
        if (nextOpen) return target
        return isDesktopSubmenuTargetActive(current, target) ? { type: 'none' } : current
      })
    },
    [setActiveDesktopSubmenu]
  )
  const activateMobileFamily = useCallback(
    (familyId: string) => {
      setActiveFamilyId(current => (current === familyId ? current : familyId))
    },
    [setActiveFamilyId]
  )

  useEffect(() => {
    const handleViewPreferenceChange = (event: Event) => {
      setAdvancedOpen((event as CustomEvent<boolean>).detail)
    }
    window.addEventListener(MODEL_SELECTOR_VIEW_CHANGED_EVENT, handleViewPreferenceChange)
    return () =>
      window.removeEventListener(MODEL_SELECTOR_VIEW_CHANGED_EVENT, handleViewPreferenceChange)
  }, [])

  useEffect(() => {
    if (!open || isMobile) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (
        containerRef.current?.contains(target) ||
        desktopMenuWrapperRef.current?.contains(target) ||
        (target instanceof Element && target.closest('[data-model-selector-layer="true"]'))
      ) {
        return
      }

      closeMenu()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [closeMenu, isMobile, open])

  useEffect(() => {
    if (!open || isMobile) return

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closeMenu, isMobile, open])

  useMobileModelSelectorFocus(open, isMobile, mobileCloseButtonRef)

  const emptyModelLabel = t('workbench.no_models', 'No models available')
  const selectedButtonLabel = selectedModel
    ? getSelectedModelDisplayLabel(selectedModel, selectedModelOptions, (key, fallback) =>
        t(key, fallback)
      )
    : familyGroups.length === 0
      ? emptyModelLabel
      : t('workbench.default_model', 'Default')
  const buttonLabel = nextTurn
    ? t('workbench.next_turn_model', 'Next · {{model}}', { model: selectedButtonLabel })
    : selectedButtonLabel

  const controlsAboveFamilies = useMemo(() => {
    const controls = selectedModel
      ? getControlsForModel(selectedModel)
      : (activeGroup?.config.controls ?? [])
    return controls.filter(
      control => isVisibleModelSelectorControl(control) && (control.scope ?? 'family') === 'family'
    )
  }, [activeGroup, selectedModel])
  const selectedModelControls = selectedModel
    ? getControlsForModel(selectedModel).filter(
        control => isVisibleModelSelectorControl(control) && control.scope === 'model'
      )
    : []
  const controlsBelowModels = selectedModelControls.filter(
    control => control.placement === 'belowModels'
  )
  const reasoningControl = controlsAboveFamilies.find(control => control.id === 'reasoning')
  const selectedReasoningValue =
    normalizeModelOptionValue('reasoning', selectedModelOptions.reasoning) ??
    reasoningControl?.defaultValue
  const selectedReasoningOption = reasoningControl?.options.find(
    option => option.value === selectedReasoningValue
  )
  const ultraLabel =
    selectedReasoningValue === 'ultra' && selectedReasoningOption
      ? selectedReasoningOption.labelKey
        ? t(selectedReasoningOption.labelKey, selectedReasoningOption.label)
        : selectedReasoningOption.label
      : undefined
  const supportsReasoningControl = Boolean(reasoningControl)
  const speedControl = controlsBelowModels.find(control => control.id === 'speed')
  const fastModeState = desktopFastModeState(speedControl, selectedModelOptions)
  const desktopReasoningControl = desktopModelControl(reasoningControl, selectedModel)
  const desktopControls = [desktopReasoningControl, speedControl].filter(
    (control): control is ModelControlConfig =>
      Boolean(control && !DESKTOP_HIDDEN_CONTROL_IDS.has(control.id))
  )
  const desktopModels = useMemo(() => familyGroups.flatMap(group => group.models), [familyGroups])
  const defaultModel = useMemo(() => findCodexDefaultModel(desktopModels), [desktopModels])
  const powerSettings = useMemo(() => getCodexModelPowerSettings(desktopModels), [desktopModels])
  const codexPowerSettingAvailable = powerSettings.some(setting =>
    isSelectedPowerSetting(setting, selectedModel, selectedModelOptions.reasoning)
  )
  const currentModelSliderAvailable = Boolean(
    isModelInterfaceModel(selectedModel) && (desktopReasoningControl?.options.length ?? 0) >= 2
  )
  const advancedReasoningMode = codexPowerSettingAvailable
    ? 'codex-power'
    : currentModelSliderAvailable
      ? 'current-model'
      : null
  const advancedReasoningAvailable = advancedReasoningMode !== null
  const powerViewOpen = advancedOpen && advancedReasoningAvailable
  useLayoutEffect(() => {
    if (!open || isMobile) return

    updateDesktopMenuLayout()
    window.addEventListener('resize', updateDesktopMenuLayout)
    return () => window.removeEventListener('resize', updateDesktopMenuLayout)
  }, [
    activeGroup?.models.length,
    powerViewOpen,
    desktopControls.length,
    desktopModels.length,
    familyGroups.length,
    isMobile,
    open,
    updateDesktopMenuLayout,
  ])

  const normalizedMobileQuery = mobileQuery.trim().toLowerCase()
  const resolveControlLabel = useCallback((key: string, fallback: string) => t(key, fallback), [t])
  const mobileModels = useMemo(() => {
    const modelsToFilter = activeGroup?.models ?? []
    if (!normalizedMobileQuery) return modelsToFilter

    return modelsToFilter.filter(model => {
      const searchableText = [
        model.name,
        model.displayName,
        model.modelId,
        getModelDisplayLabel(model, selectedModelOptions, resolveControlLabel),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return searchableText.includes(normalizedMobileQuery)
    })
  }, [activeGroup, normalizedMobileQuery, resolveControlLabel, selectedModelOptions])

  function renderControlSection(
    control: ModelControlConfig,
    {
      clearSubmenuOnHover = true,
      reasoningAsSlider = true,
    }: { clearSubmenuOnHover?: boolean; reasoningAsSlider?: boolean } = {}
  ) {
    if (control.id === 'reasoning' && reasoningAsSlider) {
      return (
        <ReasoningSlider
          key={control.id}
          control={control}
          selectedModelOptions={selectedModelOptions}
          onSelectOption={onSelectModelOption}
          clearSubmenuOnHover={clearSubmenuOnHover}
          onClearSubmenu={clearDesktopSubmenu}
        />
      )
    }

    return (
      <div
        key={control.id}
        onMouseEnter={clearSubmenuOnHover ? clearDesktopSubmenu : undefined}
        onPointerEnter={clearSubmenuOnHover ? clearDesktopSubmenu : undefined}
      >
        <div className="px-3 pb-1 pt-0.5 text-sm font-semibold text-text-muted">
          {control.labelKey ? t(control.labelKey, control.label) : control.label}
        </div>
        <div className="space-y-0.5">
          {control.options
            .slice()
            .sort((a, b) => a.order - b.order)
            .map(option => {
              const selected =
                selectedControlOption(control, selectedModelOptions)?.value === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  data-testid={`model-control-${control.id}-${option.value}`}
                  onFocus={clearSubmenuOnHover ? clearDesktopSubmenu : undefined}
                  onClick={() => handleSelectModelOption(control.id, option.value)}
                  className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm text-text-primary hover:bg-muted"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-normal">
                      {option.labelKey ? t(option.labelKey, option.label) : option.label}
                    </span>
                    {option.description && (
                      <span className="mt-0.5 block text-xs text-text-muted">
                        {option.descriptionKey
                          ? t(option.descriptionKey, option.description)
                          : option.description}
                      </span>
                    )}
                  </span>
                  {selected && <Check className="h-4 w-4 shrink-0 text-text-secondary" />}
                </button>
              )
            })}
        </div>
      </div>
    )
  }

  function renderControlMenuItem(control: ModelControlConfig) {
    const target: DesktopSubmenuTarget = { type: 'control', id: control.id }
    const active =
      activeDesktopSubmenu?.type === 'control' && activeDesktopSubmenu.id === control.id
    const selectedOption = selectedControlOption(control, selectedModelOptions)
    const selectedLabel = selectedOption
      ? selectedOption.labelKey
        ? t(selectedOption.labelKey, selectedOption.label)
        : selectedOption.label
      : control.defaultValue

    return (
      <ModelSelectorFlyout
        key={control.id}
        open={active}
        onOpenChange={nextOpen => setDesktopSubmenuOpen(target, nextOpen)}
        collisionPadding={getDesktopModelSelectorCollisionPadding()}
        contentStyle={{
          width: control.id === 'speed' ? SPEED_SUBMENU_WIDTH : undefined,
          minWidth: CONTROL_SUBMENU_MIN_WIDTH,
        }}
        anchor={
          <ModelSelectorMenuRow
            active={active}
            label={control.labelKey ? t(control.labelKey, control.label) : control.label}
            value={selectedLabel}
            testId={`model-control-menu-${control.id}`}
            onActivate={() => activateControl(control.id)}
          />
        }
      >
        {renderControlSection(control, {
          clearSubmenuOnHover: false,
          reasoningAsSlider: false,
        })}
      </ModelSelectorFlyout>
    )
  }

  function renderDesktopModelOptions(modelsToRender: UnifiedModel[], indented = false) {
    return modelsToRender.map(model => {
      const selected = model.name === selectedModel?.name && model.type === selectedModel?.type
      const modelDisabled = Boolean(model.compatibilityDisabled)
      const disabledMessage = modelDisabled
        ? modelCompatibilityDisabledMessage(model.compatibilityDisabledReason, resolveControlLabel)
        : undefined
      return (
        <button
          key={`${model.type}:${model.name}`}
          type="button"
          data-testid={`model-option-${model.name}`}
          data-model-provider-id={codexProviderId(model)}
          aria-disabled={modelDisabled}
          title={disabledMessage}
          onClick={() => {
            if (modelDisabled) {
              onBlockedModelSelect?.(model, disabledMessage)
              return
            }
            handleSelectModel(model)
            closeMenu('selection')
          }}
          className={[
            `flex h-8 w-full items-center gap-2 rounded-lg ${indented ? 'pl-5 pr-2' : 'px-2'} text-left text-sm leading-[18px]`,
            modelDisabled
              ? 'cursor-not-allowed text-text-muted hover:bg-transparent'
              : 'text-text-primary hover:bg-muted',
          ].join(' ')}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-normal">
            {disabledMessage ? (
              <span className="min-w-0 flex-1 truncate">
                {getModelDisplayLabel(model, selectedModelOptions, resolveControlLabel)}
              </span>
            ) : isCloudModel(model) ? (
              <span className="min-w-0 flex-1 truncate">
                {getModelDisplayLabel(model, {}, resolveControlLabel)}
              </span>
            ) : (
              getModelDisplayLabel(model, {}, resolveControlLabel)
            )}
            {isCloudModel(model) && (
              <Cloud
                aria-label={t('workbench.environment_cloud', '云端')}
                className="h-3.5 w-3.5 shrink-0 text-text-muted"
              />
            )}
          </span>
          {selected && <Check className="h-4 w-4 shrink-0 text-text-secondary" />}
        </button>
      )
    })
  }

  function renderEmptyModelActions(mobile = false) {
    return (
      <div
        data-testid="model-selector-empty-state"
        className={cn('space-y-3 px-3 py-4', mobile && 'rounded-2xl bg-surface px-4 py-5')}
      >
        <div className="space-y-1">
          <p className="text-sm font-medium text-text-primary">
            {t('workbench.no_models', 'No models available')}
          </p>
          <p className="text-xs leading-5 text-text-muted">
            {t(
              'workbench.no_models_guidance',
              'Add a custom model, or sign in to Wegent to sync cloud models.'
            )}
          </p>
        </div>
        <div className={cn('space-y-1', mobile && 'space-y-2')}>
          <button
            type="button"
            data-testid="model-selector-add-custom-model"
            onClick={openModelSettings}
            className={cn(
              'flex w-full items-center gap-2 text-left text-sm font-medium text-text-primary hover:bg-muted',
              mobile
                ? 'h-11 rounded-xl border border-border bg-background px-3'
                : 'h-8 rounded-lg px-2'
            )}
          >
            <Plus className="h-4 w-4 shrink-0 text-text-secondary" />
            {t('workbench.no_models_add_custom', 'Add custom model')}
          </button>
          <button
            type="button"
            data-testid="model-selector-login-cloud"
            onClick={openCloudConnectionSettings}
            className={cn(
              'flex w-full items-center gap-2 text-left text-sm font-medium',
              mobile
                ? 'h-11 rounded-xl bg-text-primary px-3 text-background'
                : 'h-8 rounded-lg px-2 text-text-primary hover:bg-muted'
            )}
          >
            <LogIn
              className={cn('h-4 w-4 shrink-0', mobile ? 'text-background' : 'text-text-secondary')}
            />
            {t('workbench.no_models_login_cloud', 'Sign in and sync cloud models')}
          </button>
        </div>
      </div>
    )
  }

  function renderMobileControlSection(control: ModelControlConfig) {
    return (
      <section key={control.id} className="space-y-2">
        <h3 className="px-1 text-xs font-semibold text-text-muted">
          {control.labelKey ? t(control.labelKey, control.label) : control.label}
        </h3>
        <div className="scrollbar-none flex gap-2 overflow-x-auto pb-1">
          {control.options
            .slice()
            .sort((a, b) => a.order - b.order)
            .map(option => {
              const selected =
                selectedControlOption(control, selectedModelOptions)?.value === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  data-testid={`model-control-${control.id}-${option.value}`}
                  onClick={() => handleSelectModelOption(control.id, option.value)}
                  className={[
                    'flex h-11 min-w-[44px] shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium',
                    selected
                      ? 'border-text-primary bg-text-primary text-background'
                      : 'border-border bg-surface text-text-secondary',
                  ].join(' ')}
                >
                  <span>{option.labelKey ? t(option.labelKey, option.label) : option.label}</span>
                  {selected && <Check className="h-4 w-4" />}
                </button>
              )
            })}
        </div>
      </section>
    )
  }

  function renderMobileSheet() {
    return createPortal(
      <div className="fixed inset-0 z-modal bg-black/25" onClick={() => closeMenu()}>
        <div
          ref={mobileMenuRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="model-selector-mobile-title"
          data-testid="model-selector-menu"
          data-mobile="true"
          className="absolute inset-x-0 bottom-0 flex h-[82dvh] flex-col rounded-t-[28px] border border-border bg-background shadow-[0_-18px_48px_rgba(0,0,0,0.18)]"
          onClick={event => event.stopPropagation()}
          onKeyDown={event =>
            handleMobileModelSelectorDialogKeyDown(event, mobileMenuRef.current, closeMenu)
          }
        >
          <div className="mx-auto mt-3 h-1 w-11 rounded-full bg-border" />
          <div className="flex items-center justify-between px-5 pb-3 pt-4">
            <div className="min-w-0">
              <h2
                id="model-selector-mobile-title"
                className="text-lg font-semibold text-text-primary"
              >
                {t('workbench.model_picker_title')}
              </h2>
              <p className="mt-1 truncate text-xs text-text-muted">{buttonLabel}</p>
            </div>
            <button
              type="button"
              ref={mobileCloseButtonRef}
              data-testid="model-selector-close-button"
              aria-label={t('workbench.close_menu')}
              onClick={() => closeMenu()}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-surface text-text-primary"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="px-5">
            <label className="flex h-11 items-center gap-3 rounded-2xl bg-surface px-4 text-text-secondary">
              <Search className="h-5 w-5 shrink-0" />
              <input
                data-testid="model-selector-search-input"
                value={mobileQuery}
                onChange={event => setMobileQuery(event.target.value)}
                placeholder={t('workbench.search_models')}
                className="min-w-0 flex-1 bg-transparent text-base leading-5 text-text-primary outline-none placeholder:text-text-muted"
              />
            </label>
          </div>

          <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-5">
            <div className="mb-5 shrink-0 space-y-4">
              {controlsAboveFamilies.map(renderMobileControlSection)}
              {!supportsReasoningControl && <ModelAutomaticReasoningOption />}
            </div>

            <div className="scrollbar-none -mx-5 mb-5 shrink-0 overflow-x-auto px-5">
              <div className="flex gap-2">
                {familyGroups.map(group => {
                  const active = group.config.id === activeGroup?.config.id
                  return (
                    <button
                      key={group.config.id}
                      type="button"
                      data-testid={`model-family-${group.config.id}`}
                      onClick={() => activateMobileFamily(group.config.id)}
                      className={[
                        'h-11 min-w-[44px] shrink-0 rounded-full px-4 text-sm font-medium',
                        active
                          ? 'bg-text-primary text-background'
                          : 'bg-surface text-text-secondary',
                      ].join(' ')}
                    >
                      {group.config.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <section
              className="flex min-h-0 flex-1 flex-col space-y-2"
              data-testid="model-selector-submenu"
            >
              <h3 className="shrink-0 px-1 text-xs font-semibold text-text-muted">
                {activeGroup?.config.label ?? t('workbench.model_version')}
              </h3>
              {mobileModels.length > 0 ? (
                <div
                  data-testid="model-selector-model-list"
                  className="scrollbar-none min-h-0 flex-1 space-y-2 overflow-y-auto pb-2"
                >
                  {mobileModels.map(model => {
                    const selected =
                      model.name === selectedModel?.name && model.type === selectedModel?.type
                    const modelDisabled = Boolean(model.compatibilityDisabled)
                    const disabledMessage = modelDisabled
                      ? modelCompatibilityDisabledMessage(
                          model.compatibilityDisabledReason,
                          resolveControlLabel
                        )
                      : undefined
                    return (
                      <button
                        key={`${model.type}:${model.name}`}
                        type="button"
                        data-testid={`model-option-${model.name}`}
                        data-model-provider-id={codexProviderId(model)}
                        aria-disabled={modelDisabled}
                        title={disabledMessage}
                        onClick={() => {
                          if (modelDisabled) {
                            onBlockedModelSelect?.(model, disabledMessage)
                            return
                          }
                          handleSelectModel(model)
                        }}
                        className={[
                          'flex min-h-14 w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left',
                          modelDisabled && 'cursor-not-allowed opacity-70',
                          selected
                            ? 'border-primary/30 bg-primary/10'
                            : 'border-transparent bg-surface',
                        ].join(' ')}
                      >
                        <span className="min-w-0 flex-1">
                          <span
                            className={[
                              'flex items-center gap-1.5 truncate text-sm font-semibold',
                              modelDisabled ? 'text-text-muted' : 'text-text-primary',
                            ].join(' ')}
                          >
                            <span className="truncate">
                              {getModelDisplayLabel(
                                model,
                                selectedModelOptions,
                                resolveControlLabel
                              )}
                            </span>
                            {isCloudModel(model) && (
                              <Cloud
                                aria-label={t('workbench.environment_cloud', '云端')}
                                className="h-3.5 w-3.5 shrink-0 text-text-muted"
                              />
                            )}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-text-muted">
                            {disabledMessage || model.displayName || model.modelId || model.name}
                          </span>
                        </span>
                        {selected && <Check className="h-5 w-5 shrink-0 text-text-primary" />}
                      </button>
                    )
                  })}
                </div>
              ) : (
                renderEmptyModelActions(true)
              )}
            </section>

            {controlsBelowModels.length > 0 && (
              <div className="mt-5 space-y-4">
                {controlsBelowModels.map(renderMobileControlSection)}
              </div>
            )}
          </div>

          <div className="flex shrink-0 gap-3 border-t border-border bg-background/95 px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-3 backdrop-blur">
            <button
              type="button"
              data-testid="model-selector-auto-button"
              onClick={() => handleSelectModel(null)}
              className="h-11 flex-1 rounded-full border border-border bg-background text-sm font-semibold text-text-primary"
            >
              {t('workbench.model_auto_select')}
            </button>
            <button
              type="button"
              data-testid="model-selector-confirm-button"
              onClick={() => closeMenu()}
              className="h-11 flex-1 rounded-full bg-text-primary text-sm font-semibold text-background"
            >
              {t('workbench.use_current_model')}
            </button>
          </div>
        </div>
      </div>,
      document.body
    )
  }

  const desktopModelLabel = selectedModel
    ? getModelDisplayLabel(selectedModel, {}, resolveControlLabel)
    : familyGroups.length === 0
      ? emptyModelLabel
      : t('workbench.default_model', 'Default')
  const modelRowActive = activeDesktopSubmenu?.type === 'models'

  return (
    <div ref={containerRef} className="group/model-selector relative min-w-0">
      {open && isMobile && renderMobileSheet()}
      {open &&
        !isMobile &&
        createPortal(
          <div
            ref={desktopMenuWrapperRef}
            style={{ left: desktopMenuLeft, top: desktopMenuTop }}
            data-model-selector-layer="true"
            data-embedded-browser-occlusion
            className={cn('fixed z-system-popover w-[224px]', menuClassName)}
          >
            <div
              ref={menuPanelRef}
              data-testid="model-selector-menu"
              data-enter-animation="main"
              style={{ maxHeight: desktopMenuMaxHeight }}
              className={cn(
                'w-[224px] shrink-0 overflow-y-auto rounded-xl border border-border/70 bg-popover/95 p-1 shadow-[0_8px_16px_-4px_rgba(0,0,0,0.18)] ring-1 ring-border/30 backdrop-blur-xl',
                styles.mainMenu
              )}
            >
              {desktopModels.length === 0 && renderEmptyModelActions()}
              {desktopModels.length > 0 && !powerViewOpen ? (
                <>
                  <div className="space-y-0.5">
                    <ModelSelectorFlyout
                      open={modelRowActive}
                      onOpenChange={nextOpen => setDesktopSubmenuOpen({ type: 'models' }, nextOpen)}
                      collisionPadding={getDesktopModelSelectorCollisionPadding()}
                      contentClassName="min-h-48"
                      contentStyle={{ width: MODEL_SUBMENU_WIDTH }}
                      anchor={
                        <ModelSelectorMenuRow
                          active={modelRowActive}
                          label={t('workbench.model_version', '模型')}
                          value={desktopModelLabel}
                          testId="model-control-menu-model"
                          onActivate={activateModels}
                        />
                      }
                    >
                      <div className="space-y-0.5 py-0.5">
                        {familyGroups.length <= 1
                          ? renderDesktopModelOptions(desktopModels)
                          : familyGroups.map(group => (
                              <div key={group.config.id}>
                                <div className="px-2 pb-0.5 pt-2 text-xs font-medium leading-4 text-text-muted first:pt-0.5">
                                  {group.config.label}
                                </div>
                                {renderDesktopModelOptions(group.models, true)}
                              </div>
                            ))}
                      </div>
                    </ModelSelectorFlyout>
                    {desktopReasoningControl ? (
                      renderControlMenuItem(desktopReasoningControl)
                    ) : (
                      <button
                        type="button"
                        data-testid="model-control-menu-reasoning"
                        disabled
                        className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm font-medium leading-[18px] text-text-muted opacity-60"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {t('workbench.reasoning_level', '推理强度')}
                        </span>
                        <span>{t('workbench.reasoning_auto', '自动')}</span>
                      </button>
                    )}
                    {speedControl ? (
                      renderControlMenuItem(speedControl)
                    ) : (
                      <button
                        type="button"
                        data-testid="model-control-menu-speed"
                        disabled
                        className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm font-medium leading-[18px] text-text-muted opacity-60"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {t('workbench.speed', '速度')}
                        </span>
                        <span>{t('workbench.speed_standard', '标准')}</span>
                      </button>
                    )}
                  </div>
                  <div className="mx-2 my-1 border-t border-border" />
                </>
              ) : null}
              {desktopModels.length > 0 &&
                (advancedReasoningAvailable ? (
                  <ModelAdvancedHeader
                    disabled={!reasoningControl}
                    interacting={powerSliderInteracting}
                    powerViewOpen={powerViewOpen}
                    fastModeEnabled={fastModeState.enabled}
                    showFastModeToggle={fastModeState.available}
                    onClearSubmenu={clearDesktopSubmenu}
                    onToggle={() => {
                      const nextValue = !advancedOpen
                      setAdvancedOpen(nextValue)
                      writeModelSelectorPowerViewPreference(nextValue)
                      setActiveDesktopSubmenu({ type: 'none' })
                    }}
                    onToggleFastMode={() => {
                      handleSelectModelOption('speed', fastModeState.nextValue)
                    }}
                  />
                ) : (
                  <ModelResetDefaultRow
                    disabled={!defaultModel}
                    onClearSubmenu={clearDesktopSubmenu}
                    onReset={() => {
                      if (!defaultModel) return
                      const defaultOptions = {
                        reasoning: CODEX_DEFAULT_REASONING_EFFORT,
                        speed: CODEX_DEFAULT_SPEED,
                      }
                      if (onSelectModelAndOptions) {
                        onSelectModelAndOptions(defaultModel, defaultOptions)
                      } else {
                        handleSelectModel(defaultModel)
                        handleSelectModelOption('reasoning', CODEX_DEFAULT_REASONING_EFFORT)
                        handleSelectModelOption('speed', CODEX_DEFAULT_SPEED)
                      }
                      clearDesktopSubmenu()
                    }}
                  />
                ))}
              {desktopModels.length > 0 && powerViewOpen && desktopReasoningControl ? (
                <div
                  data-testid="model-advanced-panel"
                  data-enter-animation="advanced"
                  className={styles.advancedPanel}
                >
                  {advancedReasoningMode === 'codex-power' ? (
                    <ModelPowerSlider
                      control={desktopReasoningControl}
                      models={desktopModels}
                      selectedModel={selectedModel}
                      selectedModelOptions={selectedModelOptions}
                      onSelectModel={handleSelectModel}
                      onSelectModelAndOptions={onSelectModelAndOptions}
                      onSelectModelOption={handleSelectModelOption}
                      onInteractionChange={setPowerSliderInteracting}
                    />
                  ) : (
                    <ReasoningSlider
                      control={desktopReasoningControl}
                      selectedModelOptions={selectedModelOptions}
                      onSelectOption={handleSelectModelOption}
                      clearSubmenuOnHover={false}
                      onInteractionChange={setPowerSliderInteracting}
                    />
                  )}
                </div>
              ) : null}
            </div>
          </div>,
          document.body
        )}
      <ModelSelectorTrigger
        buttonRef={buttonRef}
        open={open}
        disabled={disabled}
        isMobile={isMobile}
        label={buttonLabel}
        leadingIcon={
          fastModeState.enabled ? (
            <FastModeIcon
              data-testid="model-selector-fast-mode-icon"
              className="h-3.5 w-3.5 shrink-0 text-text-primary"
            />
          ) : undefined
        }
        highlightedLabel={isMobile ? undefined : ultraLabel}
        shortcut={modelSelectorShortcut}
        ariaLabel={
          fastModeState.enabled
            ? `${t('workbench.model_selector')}, ${t('workbench.speed_fast', '快速')}`
            : t('workbench.model_selector')
        }
        tooltipLabel={t('workbench.model_picker_title', '选择模型')}
        modelProviderId={codexProviderId(selectedModel)}
        buttonClassName={buttonClassName}
        maxClosedWidth={maxClosedWidth}
        onToggle={() => {
          if (disabled) return
          setOpen(current => {
            const nextOpen = !current
            if (nextOpen) {
              setCloseReason('dismiss')
              setActiveDesktopSubmenu({ type: 'none' })
              setPowerSliderInteracting(false)
            } else {
              setCloseReason('dismiss')
            }
            return nextOpen
          })
        }}
      />
    </div>
  )
}
