import { Check, ChevronRight, Cloud, Search, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'
import { getModelExecutionOverride } from '@/features/cloud-connection/modelExecution'
import { useConfiguredKeybinding } from '@/hooks/useConfiguredKeybinding'
import { useIsMobile } from '@/hooks/useIsMobile'
import {
  type ModelControlConfig,
  getControlsForModel,
  getModelDisplayLabel,
  getSelectedModelDisplayLabel,
  groupModelsByFamily,
  inferModelFamily,
  normalizeModelOptionValue,
} from '@/lib/model-ui'
import { cn } from '@/lib/utils'
import { TOGGLE_MODEL_SELECTOR_COMMAND } from '@/lib/keybindings'
import type { UnifiedModel } from '@/types/api'
import { ModelAdvancedHeader } from './ModelAdvancedHeader'
import { ModelAutomaticReasoningOption } from './ModelAutomaticReasoningOption'
import { ModelPowerSlider } from './ModelPowerSlider'
import { ModelResetDefaultRow } from './ModelResetDefaultRow'
import { ModelSelectorTrigger } from './ModelSelectorTrigger'
import { ReasoningSlider } from './ReasoningSlider'
import type { ModelSelectorProps } from './model-selector-types'
import {
  handleMobileModelSelectorDialogKeyDown,
  useMobileModelSelectorFocus,
} from './model-selector-mobile-utils'
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

const MAIN_MENU_WIDTH = 256
const SUBMENU_WIDTH = 288
const SUBMENU_GAP = 0
const VIEWPORT_MARGIN = 16
const DESKTOP_MENU_VIEWPORT_TOP = 64
const MAIN_MENU_TRIGGER_GAP = 8
const MAIN_MENU_MAX_HEIGHT = 608
const SUBMENU_RIGHT_OFFSET = MAIN_MENU_WIDTH + SUBMENU_GAP
const SUBMENU_MAX_HEIGHT = 448
const SUBMENU_VIEWPORT_VERTICAL_GAP = 128
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

function isCloudModel(model: UnifiedModel): boolean {
  return getModelExecutionOverride(model)?.source === 'cloud'
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
  const submenuPanelRef = useRef<HTMLDivElement>(null)
  const mobileMenuRef = useRef<HTMLDivElement>(null)
  const mobileCloseButtonRef = useRef<HTMLButtonElement>(null)
  const modelButtonRef = useRef<HTMLButtonElement>(null)
  const reasoningButtonRef = useRef<HTMLButtonElement>(null)
  const speedButtonRef = useRef<HTMLButtonElement>(null)
  const handledOpenSignalRef = useRef<number | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [mobileQuery, setMobileQuery] = useState('')
  const [desktopMenuTop, setDesktopMenuTop] = useState(0)
  const [desktopMenuLeft, setDesktopMenuLeft] = useState(0)
  const [desktopMenuMaxHeight, setDesktopMenuMaxHeight] = useState(MAIN_MENU_MAX_HEIGHT)
  const [submenuOffset, setSubmenuOffset] = useState(0)
  const [submenuLeft, setSubmenuLeft] = useState(SUBMENU_RIGHT_OFFSET)
  const [submenuWidth, setSubmenuWidth] = useState<number | undefined>()
  const [activeDesktopSubmenu, setActiveDesktopSubmenu] = useState<DesktopSubmenuTarget | null>(
    null
  )
  const [advancedOpen, setAdvancedOpen] = useState(readModelSelectorPowerViewPreference)
  const [powerSliderInteracting, setPowerSliderInteracting] = useState(false)
  const modelSelectorShortcut = useConfiguredKeybinding(TOGGLE_MODEL_SELECTOR_COMMAND)
  const reportedOpenRef = useRef(open)

  useEffect(() => {
    if (reportedOpenRef.current === open) return
    reportedOpenRef.current = open
    onOpenChange?.(open)
  }, [onOpenChange, open])
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

  const closeMenu = useCallback(() => {
    setOpen(false)
    setMobileQuery('')
    setActiveDesktopSubmenu(null)
    setPowerSliderInteracting(false)
  }, [setActiveDesktopSubmenu, setMobileQuery, setOpen, setPowerSliderInteracting])
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
      onSelectModel(model)
      if (isMobile) {
        closeMenu()
      }
    },
    [closeMenu, isMobile, onSelectModel]
  )
  const updateDesktopMenuLayout = useCallback(() => {
    const button = buttonRef.current
    const menuPanel = menuPanelRef.current
    if (!button || !menuPanel) return

    const viewportTop = DESKTOP_MENU_VIEWPORT_TOP
    const viewportBottom = window.innerHeight - VIEWPORT_MARGIN
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
    const maxLeft = viewportRight - VIEWPORT_MARGIN - menuWidth
    const preferredLeft = buttonRect.right - menuWidth
    const clampedLeft = Math.round(Math.max(VIEWPORT_MARGIN, Math.min(preferredLeft, maxLeft)))

    setDesktopMenuTop(clampedTop)
    setDesktopMenuLeft(clampedLeft)
    setDesktopMenuMaxHeight(menuHeight)
  }, [menuPlacement])
  const updateSubmenuLayout = useCallback((target: HTMLElement | null) => {
    if (!target || !menuPanelRef.current) {
      setSubmenuOffset(0)
      setSubmenuLeft(SUBMENU_RIGHT_OFFSET)
      setSubmenuWidth(undefined)
      return
    }

    const menuRect = menuPanelRef.current.getBoundingClientRect()
    const menuTop = menuRect.top
    const targetTop = target.getBoundingClientRect().top
    const preferredOffset = Math.round(targetTop - menuTop)
    const submenuRect = submenuPanelRef.current?.getBoundingClientRect()
    const submenuScrollHeight = submenuPanelRef.current?.scrollHeight ?? 0
    const maxSubmenuHeight = Math.min(
      SUBMENU_MAX_HEIGHT,
      Math.max(0, window.innerHeight - SUBMENU_VIEWPORT_VERTICAL_GAP)
    )
    const measuredSubmenuHeight = submenuRect?.height ?? 0
    const submenuHeight = Math.min(
      Math.max(measuredSubmenuHeight, submenuScrollHeight),
      maxSubmenuHeight
    )

    if (submenuHeight > 0) {
      const viewportTop = DESKTOP_MENU_VIEWPORT_TOP
      const viewportBottom = window.innerHeight - VIEWPORT_MARGIN
      const maxOffset = viewportBottom - submenuHeight - menuTop
      const minOffset = viewportTop - menuTop
      setSubmenuOffset(Math.round(Math.max(minOffset, Math.min(preferredOffset, maxOffset))))
    } else {
      setSubmenuOffset(preferredOffset)
    }

    const measuredMenuWidth = menuRect.width || MAIN_MENU_WIDTH
    const measuredSubmenuWidth = submenuRect?.width || SUBMENU_WIDTH
    const rightSideLeft = measuredMenuWidth + SUBMENU_GAP
    const viewportWidth = getDesktopViewportRightBoundary()
    const availableRight = viewportWidth - VIEWPORT_MARGIN - menuRect.left - rightSideLeft
    const availableLeft = menuRect.left - VIEWPORT_MARGIN - SUBMENU_GAP
    const rightSideWidth = Math.max(0, Math.min(measuredSubmenuWidth, availableRight))
    const leftSideWidth = Math.max(0, Math.min(measuredSubmenuWidth, availableLeft))

    const rightSideEdge = menuRect.left + rightSideLeft + measuredSubmenuWidth
    if (rightSideEdge <= viewportWidth - VIEWPORT_MARGIN) {
      setSubmenuWidth(undefined)
      setSubmenuLeft(rightSideLeft)
      return
    }

    const leftSideLeft = -(measuredSubmenuWidth + SUBMENU_GAP)
    if (menuRect.left + leftSideLeft >= VIEWPORT_MARGIN) {
      setSubmenuWidth(undefined)
      setSubmenuLeft(leftSideLeft)
      return
    }

    if (leftSideWidth >= rightSideWidth) {
      setSubmenuWidth(Math.round(leftSideWidth))
      setSubmenuLeft(-Math.round(leftSideWidth + SUBMENU_GAP))
      return
    }

    if (rightSideWidth > 0) {
      setSubmenuWidth(Math.round(rightSideWidth))
      setSubmenuLeft(rightSideLeft)
      return
    }

    const viewportFittedLeft = Math.max(
      VIEWPORT_MARGIN - menuRect.left,
      Math.min(
        rightSideLeft,
        viewportWidth - VIEWPORT_MARGIN - measuredSubmenuWidth - menuRect.left
      )
    )
    setSubmenuWidth(undefined)
    setSubmenuLeft(Math.round(viewportFittedLeft))
  }, [])
  const activateControl = useCallback(
    (controlId: string) => {
      setActiveDesktopSubmenu({ type: 'control', id: controlId })
    },
    [setActiveDesktopSubmenu]
  )
  const activateModels = useCallback(() => {
    setActiveDesktopSubmenu({ type: 'models' })
  }, [setActiveDesktopSubmenu])
  const clearDesktopSubmenu = useCallback(() => {
    setActiveDesktopSubmenu({ type: 'none' })
  }, [setActiveDesktopSubmenu])
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
        desktopMenuWrapperRef.current?.contains(target)
      ) {
        return
      }

      closeMenu()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [closeMenu, isMobile, open])

  useLayoutEffect(() => {
    if (!open) return
    if (activeDesktopSubmenu?.type === 'models') {
      updateSubmenuLayout(modelButtonRef.current)
      return
    }
    if (activeDesktopSubmenu?.type === 'control') {
      updateSubmenuLayout(
        activeDesktopSubmenu.id === 'reasoning'
          ? reasoningButtonRef.current
          : speedButtonRef.current
      )
      return
    }
    updateSubmenuLayout(null)
  }, [activeDesktopSubmenu, open, updateSubmenuLayout])

  useEffect(() => {
    if (!open || isMobile) return

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closeMenu, isMobile, open])

  useMobileModelSelectorFocus(open, isMobile, mobileCloseButtonRef)

  const selectedButtonLabel =
    getSelectedModelDisplayLabel(selectedModel, selectedModelOptions, (key, fallback) =>
      t(key, fallback)
    ) || t('workbench.default_model', 'Default')
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
  const ultraLabel =
    selectedReasoningValue === 'ultra' ? t('workbench.intelligence_ultra', 'Extra High') : undefined
  const supportsReasoningControl = Boolean(reasoningControl)
  const speedControl = controlsBelowModels.find(control => control.id === 'speed')
  const fastModeState = desktopFastModeState(speedControl, selectedModelOptions)
  const desktopReasoningControl = desktopModelControl(reasoningControl)
  const desktopControls = [desktopReasoningControl, speedControl].filter(
    (control): control is ModelControlConfig =>
      Boolean(control && !DESKTOP_HIDDEN_CONTROL_IDS.has(control.id))
  )
  const desktopModels = useMemo(() => familyGroups.flatMap(group => group.models), [familyGroups])
  const defaultModel = useMemo(() => findCodexDefaultModel(desktopModels), [desktopModels])
  const powerSettings = useMemo(() => getCodexModelPowerSettings(desktopModels), [desktopModels])
  const selectedPowerSettingAvailable = powerSettings.some(setting =>
    isSelectedPowerSetting(setting, selectedModel, selectedModelOptions.reasoning)
  )
  const powerViewOpen = advancedOpen && selectedPowerSettingAvailable
  const activeControl =
    activeDesktopSubmenu?.type === 'control'
      ? desktopControls.find(control => control.id === activeDesktopSubmenu.id)
      : undefined

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
                  className="flex min-h-8 w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left text-sm text-text-primary hover:bg-muted"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">
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
    const active =
      activeDesktopSubmenu?.type === 'control' && activeDesktopSubmenu.id === control.id
    const selectedOption = selectedControlOption(control, selectedModelOptions)
    const selectedLabel = selectedOption
      ? selectedOption.labelKey
        ? t(selectedOption.labelKey, selectedOption.label)
        : selectedOption.label
      : control.defaultValue

    return (
      <button
        ref={control.id === 'reasoning' ? reasoningButtonRef : speedButtonRef}
        key={control.id}
        type="button"
        data-testid={`model-control-menu-${control.id}`}
        onMouseEnter={() => activateControl(control.id)}
        onPointerEnter={() => activateControl(control.id)}
        onFocus={() => activateControl(control.id)}
        onClick={() => activateControl(control.id)}
        className={[
          'flex h-8 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium leading-[18px]',
          active
            ? 'bg-muted text-text-primary'
            : 'text-text-secondary hover:bg-muted hover:text-text-primary',
        ].join(' ')}
      >
        <span className="min-w-0 flex-1 truncate text-text-primary">
          {control.labelKey ? t(control.labelKey, control.label) : control.label}
        </span>
        <span className="max-w-24 truncate text-text-muted">{selectedLabel}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
      </button>
    )
  }

  function renderDesktopModelOptions(modelsToRender: UnifiedModel[]) {
    if (modelsToRender.length === 0) {
      return (
        <div className="rounded-lg px-3 py-6 text-center text-sm text-text-muted">
          {t('workbench.no_models', 'No models available')}
        </div>
      )
    }

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
            'flex min-h-8 w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left text-sm leading-[18px]',
            modelDisabled
              ? 'cursor-not-allowed text-text-muted hover:bg-transparent'
              : 'text-text-primary hover:bg-muted',
          ].join(' ')}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-medium">
            {disabledMessage ? (
              <span className="min-w-0 flex-1 truncate">
                <span className="block truncate">
                  {getModelDisplayLabel(model, selectedModelOptions, resolveControlLabel)}
                </span>
                <span className="mt-0.5 block truncate text-xs font-normal text-text-muted">
                  {disabledMessage}
                </span>
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
                      ? 'border-[#1f2933] bg-[#1f2933] text-white'
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
      <div className="fixed inset-0 z-modal bg-black/25" onClick={closeMenu}>
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
              onClick={closeMenu}
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
                        active ? 'bg-[#1f2933] text-white' : 'bg-surface text-text-secondary',
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
                            ? 'border-[#b9d1ca] bg-[#e8f2ef]'
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
                <div className="rounded-2xl bg-surface px-4 py-6 text-center text-sm text-text-muted">
                  {t('workbench.no_models')}
                </div>
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
              onClick={closeMenu}
              className="h-11 flex-1 rounded-full bg-[#1f2933] text-sm font-semibold text-white"
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
            className={cn('fixed z-system-popover w-64', menuClassName)}
          >
            <div
              ref={menuPanelRef}
              data-testid="model-selector-menu"
              data-enter-animation="main"
              style={{ maxHeight: desktopMenuMaxHeight }}
              className={cn(
                'w-64 shrink-0 overflow-y-auto rounded-2xl border border-border bg-background p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]',
                styles.mainMenu
              )}
            >
              {!powerViewOpen ? (
                <>
                  <div className="space-y-0.5">
                    <button
                      ref={modelButtonRef}
                      type="button"
                      data-testid="model-control-menu-model"
                      onMouseEnter={activateModels}
                      onPointerEnter={activateModels}
                      onFocus={activateModels}
                      onClick={activateModels}
                      className={cn(
                        'flex h-8 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium leading-[18px]',
                        modelRowActive
                          ? 'bg-muted text-text-primary'
                          : 'text-text-secondary hover:bg-muted hover:text-text-primary'
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate text-text-primary">
                        {t('workbench.model_version', '模型')}
                      </span>
                      <span className="max-w-24 truncate text-text-muted">{desktopModelLabel}</span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
                    </button>
                    {desktopReasoningControl ? (
                      renderControlMenuItem(desktopReasoningControl)
                    ) : (
                      <button
                        type="button"
                        data-testid="model-control-menu-reasoning"
                        disabled
                        className="flex h-8 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium leading-[18px] text-text-muted opacity-60"
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
                        className="flex h-8 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium leading-[18px] text-text-muted opacity-60"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {t('workbench.speed', '速度')}
                        </span>
                        <span>{t('workbench.speed_standard', '标准')}</span>
                      </button>
                    )}
                  </div>
                  <div className="mx-3 my-1.5 border-t border-border" />
                </>
              ) : null}
              {selectedPowerSettingAvailable ? (
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
              )}
              {powerViewOpen && desktopReasoningControl ? (
                <div
                  data-testid="model-advanced-panel"
                  data-enter-animation="advanced"
                  className={styles.advancedPanel}
                >
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
                </div>
              ) : null}
            </div>

            {activeControl ? (
              <div
                key={`control:${activeControl.id}`}
                ref={submenuPanelRef}
                data-testid="model-selector-submenu"
                data-enter-animation="submenu"
                style={{ top: submenuOffset, left: submenuLeft, width: submenuWidth }}
                className={cn(
                  'absolute max-h-[min(28rem,calc(100vh-8rem))] w-72 overflow-y-auto rounded-2xl border border-border bg-background p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]',
                  styles.submenu
                )}
              >
                {renderControlSection(activeControl, {
                  clearSubmenuOnHover: false,
                  reasoningAsSlider: false,
                })}
              </div>
            ) : activeDesktopSubmenu?.type === 'models' ? (
              <div
                key="models"
                ref={submenuPanelRef}
                data-testid="model-selector-submenu"
                data-enter-animation="submenu"
                style={{ top: submenuOffset, left: submenuLeft, width: submenuWidth }}
                className={cn(
                  'absolute max-h-[min(28rem,calc(100vh-8rem))] min-h-48 w-72 overflow-y-auto rounded-2xl border border-border bg-background p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]',
                  styles.submenu
                )}
              >
                <div className="px-3 pb-1.5 pt-0.5 text-sm font-semibold leading-[18px] text-text-muted">
                  {t('workbench.model_version', '模型')}
                </div>
                <div className="space-y-0.5">
                  {familyGroups.length <= 1
                    ? renderDesktopModelOptions(desktopModels)
                    : familyGroups.map(group => (
                        <div key={group.config.id} className="pb-1 last:pb-0">
                          <div className="px-3 pb-1 pt-2 text-xs font-medium text-text-muted first:pt-0">
                            {group.config.label}
                          </div>
                          {renderDesktopModelOptions(group.models)}
                        </div>
                      ))}
                </div>
              </div>
            ) : null}
          </div>,
          document.body
        )}
      <ModelSelectorTrigger
        buttonRef={buttonRef}
        open={open}
        disabled={disabled}
        isMobile={isMobile}
        label={buttonLabel}
        highlightedLabel={isMobile ? undefined : ultraLabel}
        shortcut={modelSelectorShortcut}
        ariaLabel={t('workbench.model_selector')}
        tooltipLabel={t('workbench.model_picker_title', '选择模型')}
        buttonClassName={buttonClassName}
        maxClosedWidth={maxClosedWidth}
        onToggle={() => {
          if (disabled) return
          setOpen(current => {
            const nextOpen = !current
            if (nextOpen) {
              setActiveDesktopSubmenu({ type: 'none' })
              setPowerSliderInteracting(false)
            }
            return nextOpen
          })
        }}
      />
    </div>
  )
}
