import { createModelSelectorPopover } from './modelSelectorPopover'
import { controlOption } from './recipes'
import { keepFocus } from '@ui-sdk/core'
import { Popover, PopoverContent } from './Popover'
import { Check, Cloud } from 'lucide-react'
import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { ModelSelectorEmptyState } from './ModelSelectorEmptyState'
import { ModelSelectorMobileControl } from './ModelSelectorMobileControl'
import { Radio, RadioGroup } from './RadioGroup'

import type { UnifiedModel } from '@wegent/chat-core/models'
import type { CollaborationTranslate } from '../i18n'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { useCollaborationPortalTheme } from '../theme'
import { FastModeIcon } from './FastModeIcon'
import { MobileModelSelector } from './MobileModelSelector'
import {
  MODEL_SELECTOR_MAX_HEIGHT,
  MODEL_SELECTOR_VIEWPORT_MARGIN,
} from './model-selector-layout'
import type {
  ModelSelectorCloseReason,
  ModelSelectorProps,
} from './model-selector-types'
import {
  codexProviderId,
  desktopFastModeState,
  getModelPowerPresets,
  isCloudModel,
  isSelectedPowerSetting,
  isVisibleModelSelectorControl,
  modelCompatibilityDisabledMessage,
  modelPowerOptions,
} from './model-selector-utils'
import {
  MODEL_SELECTION_OPTION,
  getControlsForModel,
  getDefaultModelOptions,
  getModelDisplayLabel,
  getSelectedModelDisplayLabel,
  getSelectedReasoningOption,
  groupModelsByFamily,
  inferModelFamily,
  isCodexOfficialModel,
  isSameModelSelection,
  modelSelectionKey,
  normalizeModelOptionValue,
  normalizeModelOptions,
  type ModelControlConfig,
} from './model-ui'
import styles from './ModelSelector.module.css'
import { ModelSelectorSimplePanel } from './ModelSelectorSimplePanel'
import { ModelSelectorTrigger } from './ModelSelectorTrigger'
import { defaultNewChatModel } from './runtimeModelSelection'
import { useModelPresetSelection } from './useModelPresetSelection'

const MAIN_MENU_WIDTH = 320
const ADVANCED_MENU_FALLBACK_HEIGHT = 316

export type ModelSelectorHostProps = {
  translate: CollaborationTranslate
  isMobile: boolean
  shortcut?: string | null
  onOpenCloudConnections?: () => void
  onFlyoutOpenChange?: (open: boolean) => void
  getViewportRightBoundary?: (anchor: HTMLElement | null) => number
} & (
  | { onOpenModelSettings: () => void; emptyState?: ReactNode }
  | { onOpenModelSettings?: undefined; emptyState: ReactNode }
)

export function ModelSelector({
  translate: t,
  isMobile,
  shortcut: modelSelectorShortcut,
  onOpenModelSettings,
  emptyState,
  onOpenCloudConnections,
  onFlyoutOpenChange,
  getViewportRightBoundary,

  models,
  getModelOptionId,
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
  menuAlign = 'end',
  buttonClassName = '',
  menuClassName = '',
  maxClosedWidth,
}: ModelSelectorProps & ModelSelectorHostProps) {
  const portalTheme = useCollaborationPortalTheme()
  const desktopMenuId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const menuPanelRef = useRef<HTMLDivElement>(null)
  const simplePanelRef = useRef<HTMLDivElement>(null)
  const advancedPanelRef = useRef<HTMLDivElement>(null)
  const [popover] = useState(createModelSelectorPopover)
  const renderedOpen = popover.getSnapshot().open
  const subscribePopover = useCallback(
    (listener: () => void) =>
      popover.subscribe(listener, {
        isMobile,
        disabled,
        openSignal,
        renderedOpen,
        onOpenChange,
        onFlyoutOpenChange,
      }),
    [popover, isMobile, disabled, openSignal, renderedOpen, onOpenChange, onFlyoutOpenChange]
  )
  const popoverState = useSyncExternalStore(
    subscribePopover,
    popover.getSnapshot,
    popover.getSnapshot
  )
  const { open, mobileQuery, desktopView: desktopMenuView } = popoverState
  const setMobileQuery = popover.setMobileQuery
  const setDesktopMenuView = popover.setDesktopView
  const [desktopMenuWidth, setDesktopMenuWidth] = useState(MAIN_MENU_WIDTH)
  const desktopMenuMaxHeight = MODEL_SELECTOR_MAX_HEIGHT
  useLayoutEffect(() => {
    if (!open || isMobile) return
    const available =
      getViewportRightBoundary?.(buttonRef.current) ?? window.innerWidth
    setDesktopMenuWidth(
      Math.min(
        MAIN_MENU_WIDTH,
        Math.max(0, available - 2 * MODEL_SELECTOR_VIEWPORT_MARGIN),
      ),
    )
  }, [getViewportRightBoundary, isMobile, open])

  const [, setPowerSliderInteracting] = useState(false)
  const familyGroups = useMemo(() => groupModelsByFamily(models), [models])
  const defaultModel = useMemo(() => defaultNewChatModel(models), [models])
  const desktopModels = useMemo(
    () => familyGroups.flatMap((group) => group.models),
    [familyGroups],
  )
  const powerPresets = useMemo(
    () => getModelPowerPresets(desktopModels, defaultModel),
    [defaultModel, desktopModels],
  )
  const {
    defaultPowerPreset,
    activePowerPreset,
    modelSelectionMode,
    defaultModelSelected,
    selectFixedMode,
    selectPresetMode,
  } = useModelPresetSelection(
    powerPresets,
    defaultModel,
    selectedModel,
    selectedModelOptions,
  )
  const powerSettings = activePowerPreset?.settings ?? []
  const hasRecommendedDefault = powerPresets.length > 0
  const selectedFamily = selectedModel
    ? inferModelFamily(selectedModel)
    : familyGroups[0]?.config.id
  const [activeFamilyId, setActiveFamilyId] = useState(selectedFamily ?? '')
  const displayedFamilyId =
    activeFamilyId || selectedFamily || familyGroups[0]?.config.id || ''
  const activeGroup =
    familyGroups.find((group) => group.config.id === displayedFamilyId) ??
    familyGroups[0]

  const closeMenu = useCallback(
    (reason: ModelSelectorCloseReason = 'dismiss') => {
      popover.close(reason)
      setPowerSliderInteracting(false)
    },
    [popover],
  )
  const openModelSettings = useCallback(() => {
    closeMenu()
    onOpenModelSettings?.()
  }, [closeMenu, onOpenModelSettings])
  const openCloudConnectionSettings = useCallback(() => {
    closeMenu()
    onOpenCloudConnections?.()
  }, [closeMenu, onOpenCloudConnections])
  const handleSelectModelOption = useCallback(
    (optionId: string, value: string) => {
      onSelectModelOption(optionId, value)
      if (isMobile) {
        closeMenu()
      }
    },
    [closeMenu, isMobile, onSelectModelOption],
  )
  const handleSelectModel = useCallback(
    (model: UnifiedModel | null) => {
      const selectionApplied = onSelectModel(model)
      if (isMobile && selectionApplied !== false) {
        closeMenu()
      }
      return selectionApplied
    },
    [closeMenu, isMobile, onSelectModel],
  )

  const activateMobileFamily = useCallback(
    (familyId: string) => {
      setActiveFamilyId((current) =>
        current === familyId ? current : familyId,
      )
    },
    [setActiveFamilyId],
  )

  const desktopMenuWrapperRef = useRef<HTMLDivElement>(null)

  const emptyModelLabel = t('workbench.no_models', 'No models available')
  const selectedModelLabel = selectedModel
    ? getSelectedModelDisplayLabel(
        selectedModel,
        selectedModelOptions,
        (key, fallback) => t(key, fallback),
      )
    : familyGroups.length === 0
      ? emptyModelLabel
      : t('workbench.model_picker_title', 'Select model')
  const selectedModelName = selectedModel
    ? getModelDisplayLabel(selectedModel, {}, (key, fallback) =>
        t(key, fallback),
      )
    : selectedModelLabel
  const selectedModelSourceLabel = selectedModel
    ? isCodexOfficialModel(selectedModel)
      ? t('workbench.model_source_local_chatgpt', '本机 ChatGPT 账户')
      : isCloudModel(selectedModel)
        ? t('workbench.model_source_cloud', '云端模型')
        : t('workbench.model_source_custom', '自定义模型')
    : undefined
  const controlsAboveFamilies = useMemo(() => {
    const controls = selectedModel
      ? getControlsForModel(selectedModel)
      : (activeGroup?.config.controls ?? [])
    return controls.filter(
      (control) =>
        isVisibleModelSelectorControl(control) &&
        (control.scope ?? 'family') === 'family',
    )
  }, [activeGroup, selectedModel])
  const selectedModelControls = selectedModel
    ? getControlsForModel(selectedModel).filter(
        (control) =>
          isVisibleModelSelectorControl(control) && control.scope === 'model',
      )
    : []
  const controlsBelowModels = selectedModelControls.filter(
    (control) => control.placement === 'belowModels',
  )
  const reasoningControl = controlsAboveFamilies.find(
    (control) => control.id === 'reasoning',
  )
  const selectedReasoningValue =
    normalizeModelOptionValue('reasoning', selectedModelOptions.reasoning) ??
    reasoningControl?.defaultValue
  const selectedReasoningOption = getSelectedReasoningOption(
    selectedModel,
    selectedModelOptions,
  )
  const selectedReasoningLabel = selectedReasoningOption
    ? selectedReasoningOption.labelKey
      ? t(selectedReasoningOption.labelKey, selectedReasoningOption.label)
      : selectedReasoningOption.label
    : undefined
  const ultraLabel =
    selectedReasoningValue === 'ultra' && selectedReasoningOption
      ? selectedReasoningOption.labelKey
        ? t(selectedReasoningOption.labelKey, selectedReasoningOption.label)
        : selectedReasoningOption.label
      : undefined
  const supportsReasoningControl = Boolean(reasoningControl)
  const speedControl = controlsBelowModels.find(
    (control) => control.id === 'speed',
  )
  const fastModeState = desktopFastModeState(speedControl, selectedModelOptions)
  const desktopModelGroups = familyGroups
  const localChatGptModelGroups = desktopModelGroups.flatMap((group) => {
    const localModels = group.models.filter(isCodexOfficialModel)
    return localModels.length > 0 ? [{ ...group, models: localModels }] : []
  })
  const cloudDesktopModelGroups = desktopModelGroups.flatMap((group) => {
    const cloudModels = group.models.filter(
      (model) => isCloudModel(model) && !isCodexOfficialModel(model),
    )
    return cloudModels.length > 0 ? [{ ...group, models: cloudModels }] : []
  })
  const customDesktopModelGroups = desktopModelGroups.flatMap((group) => {
    const customModels = group.models.filter(
      (model) => !isCloudModel(model) && !isCodexOfficialModel(model),
    )
    return customModels.length > 0 ? [{ ...group, models: customModels }] : []
  })
  const useModelPowerSlider =
    modelSelectionMode === 'default' && powerSettings.length >= 2
  const advancedReasoningAvailable =
    useModelPowerSlider ||
    (modelSelectionMode === 'model' &&
      (reasoningControl?.options.length ?? 0) >= 2)
  const showExplicitEffortSelection =
    modelSelectionMode === 'model' &&
    (reasoningControl?.options.length ?? 0) >= 2
  const resolvedDesktopMenuView = advancedReasoningAvailable
    ? desktopMenuView
    : 'advanced'
  const selectedButtonLabel =
    open && resolvedDesktopMenuView === 'simple'
      ? showExplicitEffortSelection
        ? t('workbench.select_reasoning_effort', 'Select effort')
        : t('workbench.model_picker_title', 'Select model')
      : selectedModelLabel

  const buttonLabel = nextTurn
    ? t('workbench.next_turn_model', 'Next · {{model}}', {
        model: selectedButtonLabel,
      })
    : selectedButtonLabel

  const normalizedMobileQuery = mobileQuery.trim().toLowerCase()
  const resolveControlLabel = useCallback(
    (key: string, fallback: string) => t(key, fallback),
    [t],
  )
  const mobileModels = useMemo(() => {
    const modelsToFilter = activeGroup?.models ?? []
    if (!normalizedMobileQuery) return modelsToFilter

    return modelsToFilter.filter((model) => {
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
  }, [
    activeGroup,
    normalizedMobileQuery,
    resolveControlLabel,
    selectedModelOptions,
  ])

  function renderDesktopModelOptions(modelsToRender: UnifiedModel[]) {
    return modelsToRender.map((model) => {
      const selected =
        modelSelectionMode === 'model' &&
        isSameModelSelection(model, selectedModel)
      const modelDisabled = Boolean(model.compatibilityDisabled)
      const disabledMessage = modelDisabled
        ? modelCompatibilityDisabledMessage(
            model.compatibilityDisabledReason,
            resolveControlLabel,
          )
        : undefined
      return (
        <Radio
          value={'model:' + modelSelectionKey(model)}
          aria-disabled={modelDisabled || undefined}
          key={modelSelectionKey(model)}
          type="button"
          data-testid={`model-option-${getModelOptionId?.(model) ?? model.name}`}
          data-model-provider-id={codexProviderId(model)}
          title={disabledMessage}
          onClick={() => {
            // Reapplying the current model can recover a session after its provider changed.
            if (selected && modelDisabled) onBlockedModelSelect?.(model, disabledMessage)
            else if (selected) selectDesktopModel(model)
          }}
          className={[
            controlOption,
            'shrink-0',
            modelDisabled
              ? 'cursor-not-allowed text-text-muted hover:bg-transparent focus-visible:bg-transparent'
              : 'text-text-primary hover:bg-muted focus-visible:bg-muted',
          ].join(' ')}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-normal">
            {disabledMessage ? (
              <span className="min-w-0 flex-1 truncate">
                {getModelDisplayLabel(
                  model,
                  selectedModelOptions,
                  resolveControlLabel,
                )}
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
          {selected && (
            <Check className="h-4 w-4 shrink-0 text-text-secondary" />
          )}
        </Radio>
      )
    })
  }

  function focusAdvancedChoice() {
    return (
      advancedPanelRef.current?.querySelector<HTMLElement>(
        '[role="radio"][aria-checked="true"]',
      ) ??
      advancedPanelRef.current?.querySelector<HTMLElement>(
        '[role="radio"]:not([disabled])',
      ) ??
      undefined
    )
  }

  function openAdvancedModels() {
    setDesktopMenuView('advanced')
    keepFocus(focusAdvancedChoice)
  }

  function renderPowerPresetOptions(groupModels: UnifiedModel[]) {
    return powerPresets
      .filter((preset) =>
        groupModels.some((model) => isSameModelSelection(model, preset.owner)),
      )
      .map((preset) => {
        const isDefaultPreset = preset.key === defaultPowerPreset?.key
        const selected =
          defaultModelSelected && activePowerPreset?.key === preset.key
        return (
          <Radio
            value={'preset:' + preset.key}
            key={preset.key}
            type="button"
            data-testid={
              isDefaultPreset
                ? 'model-option-default'
                : `model-option-preset-${preset.name}`
            }
            data-model-preset={preset.name}
            onClick={() => {
              // Reapplying a preset is a business action even when its radio value is unchanged.
              if (selected) selectPowerPreset(preset)
            }}
            className={`${controlOption} shrink-0 transition-colors focus-visible:bg-muted`}
          >
            <span className="min-w-0 flex-1">
              <span className={styles.defaultTitle}>
                {isDefaultPreset
                  ? t('workbench.default_model', '默认')
                  : preset.label}
              </span>
              <span className={styles.defaultDescription}>
                {preset.description ??
                  (isDefaultPreset
                    ? t('workbench.model_recommended_set', '推荐模型集')
                    : t('workbench.model_set', '模型集'))}
              </span>
            </span>
            {selected && (
              <Check className="h-4 w-4 shrink-0 text-text-secondary" />
            )}
          </Radio>
        )
      })
  }

  function renderAdvancedModelSource(
    testId: string,
    label: string,
    groups: typeof desktopModelGroups,
    showFamilyLabels: boolean,
  ) {
    if (groups.length === 0) return null
    return (
      <div data-testid={testId}>
        <div className={styles.groupLabel}>{label}</div>
        {renderPowerPresetOptions(groups.flatMap((group) => group.models))}
        {groups.map((group) => (
          <div
            key={group.config.id}
            data-testid={`model-group-${group.config.id}`}
          >
            {showFamilyLabels ? (
              <div className={styles.subgroupLabel}>{group.config.label}</div>
            ) : null}
            {renderDesktopModelOptions(group.models)}
          </div>
        ))}
      </div>
    )
  }

  function renderMobileControlSection(control: ModelControlConfig) {
    return (
      <ModelSelectorMobileControl
        key={control.id}
        control={control}
        options={selectedModelOptions}
        translate={t}
        onSelectOption={handleSelectModelOption}
      />
    )
  }

  function selectExplicitModel(model: UnifiedModel | null) {
    if (!model) return handleSelectModel(null)
    const baseOptions =
      selectedModel &&
      inferModelFamily(model) === inferModelFamily(selectedModel)
        ? selectedModelOptions
        : getDefaultModelOptions(model)
    const options = normalizeModelOptions(model, {
      ...baseOptions,
      [MODEL_SELECTION_OPTION]: 'model',
    })
    const applied = onSelectModelAndOptions
      ? onSelectModelAndOptions(model, options)
      : handleSelectModel(model)
    if (applied === false) return false
    if (!onSelectModelAndOptions)
      handleSelectModelOption(MODEL_SELECTION_OPTION, 'model')
    selectFixedMode()
    if (isMobile) closeMenu('selection')
    return applied
  }

  function selectDesktopModel(model: UnifiedModel) {
    if (selectExplicitModel(model) === false) {
      closeMenu('selection')
      return false
    }
    setDesktopMenuView('simple')
    keepFocus(
      () =>
        simplePanelRef.current?.querySelector<HTMLElement>(
          'button:not([disabled]), input:not([disabled])',
        ) ?? undefined,
    )
    return true
  }

  function selectPowerPreset(preset: (typeof powerPresets)[number]) {
    const ownerReasoningControl = getControlsForModel(preset.owner).find(
      (control) => control.id === 'reasoning',
    )
    const selectedSetting =
      preset.settings.find((setting) =>
        isSelectedPowerSetting(
          setting,
          preset.owner,
          ownerReasoningControl?.defaultValue,
        ),
      ) ?? preset.settings[0]
    if (!selectedSetting) return
    const speedControl = getControlsForModel(selectedSetting.model).find(
      (control) => control.id === 'speed',
    )
    const defaultOptions = modelPowerOptions(selectedSetting, {
      [MODEL_SELECTION_OPTION]: preset.key,
      ...(speedControl?.defaultValue
        ? { speed: speedControl.defaultValue }
        : {}),
    })
    if (onSelectModelAndOptions) {
      if (
        onSelectModelAndOptions(selectedSetting.model, defaultOptions) === false
      ) {
        closeMenu('selection')
        return
      }
    } else {
      if (handleSelectModel(selectedSetting.model) === false) {
        closeMenu('selection')
        return
      }
      if (selectedSetting.reasoningEffort !== undefined) {
        handleSelectModelOption('reasoning', selectedSetting.reasoningEffort)
      }
      if (speedControl?.defaultValue) {
        handleSelectModelOption('speed', speedControl.defaultValue)
      }
    }
    if (!onSelectModelAndOptions)
      handleSelectModelOption(MODEL_SELECTION_OPTION, preset.key)
    selectPresetMode(preset)
    setDesktopMenuView('simple')
    keepFocus(
      () =>
        simplePanelRef.current?.querySelector<HTMLElement>(
          'button:not([disabled]), input:not([disabled])',
        ) ?? undefined,
    )
  }

  function selectDefaultModel() {
    if (defaultPowerPreset) selectPowerPreset(defaultPowerPreset)
  }

  return (
    <Popover
      open={open && !isMobile}
      modal
      onOpenChange={(next) => {
        if (!next) closeMenu()
      }}
    >
      <div ref={containerRef} className="group/model-selector relative min-w-0">
        {open && isMobile && (
          <MobileModelSelector
            translate={t}
            buttonLabel={buttonLabel}
            mobileQuery={mobileQuery}
            setMobileQuery={setMobileQuery}
            controlsAboveFamilies={controlsAboveFamilies}
            controlsBelowModels={controlsBelowModels}
            renderMobileControlSection={renderMobileControlSection}
            supportsReasoningControl={supportsReasoningControl}
            familyGroups={familyGroups}
            activeGroup={activeGroup}
            activateMobileFamily={activateMobileFamily}
            mobileModels={mobileModels}
            selectedModel={selectedModel}
            selectedModelOptions={selectedModelOptions}
            getModelOptionId={getModelOptionId}
            onBlockedModelSelect={onBlockedModelSelect}
            handleSelectModel={selectExplicitModel}
            closeMenu={closeMenu}
            emptyState={
              emptyState ?? (
                <ModelSelectorEmptyState
                  translate={t}
                  mobile
                  onOpenModelSettings={openModelSettings}
                  onOpenCloudConnections={
                    onOpenCloudConnections
                      ? openCloudConnectionSettings
                      : undefined
                  }
                />
              )
            }
          />
        )}
        {open && !isMobile && (
          <PopoverContent
            container={document.body}
            anchor={anchor}
            side={menuPlacement === 'above' ? 'top' : 'bottom'}
            align={menuAlign}
            sideOffset={8}
            collisionPadding={16}
            initialFocus={() =>
              resolvedDesktopMenuView === 'advanced'
                ? focusAdvancedChoice()
                : (simplePanelRef.current?.querySelector<HTMLElement>(
                    'button:not([disabled]), input:not([disabled])',
                  ) ?? undefined)
            }
            {...portalTheme}
            ref={desktopMenuWrapperRef}
            id={desktopMenuId}
            aria-label={t('workbench.model_picker_title', '选择模型')}
            tabIndex={-1}
            style={{
              ...portalTheme.style,
              width: desktopMenuWidth,
              maxHeight: 'min(608px, var(--available-height))',
              overflowY: 'auto',
            }}
            data-model-selector-layer="true"
            data-embedded-browser-occlusion
            className={cn(
              portalTheme.className,
              'z-system-popover',
              styles.menuWrapper,
              menuClassName,
            )}
          >
            <div
              ref={menuPanelRef}
              data-testid="model-selector-menu"
              data-panel={resolvedDesktopMenuView}
              data-enter-animation="main"
              style={{
                maxHeight: desktopMenuMaxHeight,
                transformOrigin: 'var(--transform-origin)',
              }}
              className={cn(
                'w-full shrink-0 overflow-hidden rounded-2xl bg-popover',
                styles.mainMenu,
              )}
            >
              {desktopModels.length === 0 &&
                (emptyState ?? (
                  <ModelSelectorEmptyState
                    translate={t}
                    onOpenModelSettings={openModelSettings}
                    onOpenCloudConnections={
                      onOpenCloudConnections
                        ? openCloudConnectionSettings
                        : undefined
                    }
                  />
                ))}
              {desktopModels.length > 0 ? (
                <div
                  className={styles.viewContainer}
                  data-model-picker-view={resolvedDesktopMenuView}
                  style={{}}
                >
                  {advancedReasoningAvailable ? (
                    <div
                      aria-hidden={resolvedDesktopMenuView === 'advanced'}
                      className={styles.viewTrack}
                      data-active={resolvedDesktopMenuView === 'simple'}
                      inert={
                        resolvedDesktopMenuView === 'advanced'
                          ? true
                          : undefined
                      }
                    >
                      <ModelSelectorSimplePanel
                        translate={t}
                        panelRef={simplePanelRef}
                        maxHeight={desktopMenuMaxHeight}
                        sourceLabel={selectedModelSourceLabel}
                        modelName={selectedModelName}
                        reasoningLabel={selectedReasoningLabel}
                        preset={activePowerPreset}
                        presetSelected={defaultModelSelected}
                        resetAvailable={
                          hasRecommendedDefault &&
                          !defaultModelSelected &&
                          Boolean(defaultPowerPreset)
                        }
                        fastModeState={fastModeState}
                        control={reasoningControl}
                        onOpenModels={openAdvancedModels}
                        onReset={selectDefaultModel}
                        onInteractionChange={setPowerSliderInteracting}
                        selectedModel={selectedModel}
                        selectedModelOptions={selectedModelOptions}
                        onSelectModel={handleSelectModel}
                        onSelectModelAndOptions={onSelectModelAndOptions}
                        onSelectModelOption={handleSelectModelOption}
                      />
                    </div>
                  ) : null}

                  <div
                    aria-hidden={resolvedDesktopMenuView === 'simple'}
                    className={styles.advancedViewTrack}
                    data-active={resolvedDesktopMenuView === 'advanced'}
                    inert={
                      resolvedDesktopMenuView === 'simple' ? true : undefined
                    }
                  >
                    <div
                      ref={advancedPanelRef}
                      data-model-picker-panel="advanced"
                      className={styles.advancedPanel}
                      style={{
                        maxHeight: Math.min(
                          ADVANCED_MENU_FALLBACK_HEIGHT,
                          desktopMenuMaxHeight,
                        ),
                      }}
                    >
                      <div className={styles.sectionLabel}>
                        {t('workbench.model_picker_title', '选择模型')}
                      </div>
                      <RadioGroup
                        value={
                          modelSelectionMode === 'model' && selectedModel
                            ? 'model:' + modelSelectionKey(selectedModel)
                            : 'preset:' + activePowerPreset?.key
                        }
                        onValueChange={(choice, details) => {
                          if (choice?.startsWith('model:')) {
                            const model = models.find(
                              (model) =>
                                'model:' + modelSelectionKey(model) === choice,
                            )
                            if (!model) return
                            if (model.compatibilityDisabled) {
                              details.cancel()
                              onBlockedModelSelect?.(
                                model,
                                modelCompatibilityDisabledMessage(
                                  model.compatibilityDisabledReason,
                                  resolveControlLabel,
                                ),
                              )
                              return
                            }
                            if (!selectDesktopModel(model)) details.cancel()
                          } else {
                            const preset = powerPresets.find(
                              (preset) => 'preset:' + preset.key === choice,
                            )
                            if (preset) selectPowerPreset(preset)
                          }
                        }}
                        aria-label={t(
                          'workbench.model_picker_title',
                          '选择模型',
                        )}
                      >
                        {renderAdvancedModelSource(
                          'model-source-local-chatgpt',
                          t(
                            'workbench.model_source_local_chatgpt',
                            '本机 ChatGPT 账户',
                          ),
                          localChatGptModelGroups,
                          false,
                        )}
                        {renderAdvancedModelSource(
                          'model-source-cloud',
                          t('workbench.model_source_cloud', '云端模型'),
                          cloudDesktopModelGroups,
                          true,
                        )}
                        {renderAdvancedModelSource(
                          'model-source-custom',
                          t('workbench.model_source_custom', '自定义模型'),
                          customDesktopModelGroups,
                          true,
                        )}
                      </RadioGroup>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </PopoverContent>
        )}
        <ModelSelectorTrigger
          buttonRef={buttonRef}
          onButtonChange={setAnchor}
          popupId={isMobile ? undefined : desktopMenuId}
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
            if (open) {
              closeMenu()
              return
            }
            // Preserve the panel opened before asynchronous reasoning controls arrive.
            setDesktopMenuView(
              advancedReasoningAvailable ? 'simple' : 'advanced',
            )
            setPowerSliderInteracting(false)
            popover.open()
          }}
        />
      </div>
    </Popover>
  )
}
