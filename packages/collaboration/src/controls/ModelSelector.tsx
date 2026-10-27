import { ModelSelectorEmptyState } from "./ModelSelectorEmptyState";
import { Check, ChevronRight, Cloud, RotateCcw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { CollaborationTranslate } from "../i18n";
import { useCollaborationPortalTheme } from "../theme";
import {
  type ModelControlConfig,
  getControlsForModel,
  getModelDisplayLabel,
  getSelectedModelDisplayLabel,
  groupModelsByFamily,
  inferModelFamily,
  isCodexOfficialModel,
  isSameModelSelection,
  modelSelectionKey,
  normalizeModelOptionValue,
} from "./model-ui";
import { activityClassNames as cn } from "../issue-detail/activityClassNames";
import type { UnifiedModel } from "@wegent/chat-core/models";
import { FastModeIcon } from "./FastModeIcon";
import { ModelPowerSlider } from "./ModelPowerSlider";
import { ModelSelectorTrigger } from "./ModelSelectorTrigger";
import { ReasoningSlider } from "./ReasoningSlider";
import type {
  ModelSelectorCloseReason,
  ModelSelectorProps,
} from "./model-selector-types";
import { MobileModelSelector } from "./MobileModelSelector";
import { defaultNewChatModel } from "./runtimeModelSelection";
import {
  MODEL_SELECTOR_VIEWPORT_MARGIN,
  MODEL_SELECTOR_VIEWPORT_TOP,
} from "./model-selector-layout";
import {
  isCloudModel,
  codexProviderId,
  desktopFastModeState,
  desktopModelControl,
  getModelPowerPresets,
  isSelectedPowerSetting,
  isVisibleModelSelectorControl,
  modelCompatibilityDisabledMessage,
  modelPowerOptions,
  selectedControlOption,
} from "./model-selector-utils";
import styles from "./ModelSelector.module.css";

const MAIN_MENU_WIDTH = 254;
const MAIN_MENU_TRIGGER_GAP = 8;
const MAIN_MENU_MAX_HEIGHT = 608;
const SIMPLE_MENU_FALLBACK_HEIGHT = 80;
const ADVANCED_MENU_FALLBACK_HEIGHT = 316;
type DesktopMenuView = "simple" | "advanced";
type ModelSelectionMode = "default" | "model";

export interface ModelSelectorHostProps {
  translate: CollaborationTranslate;
  isMobile: boolean;
  shortcut?: string | null;
  onOpenModelSettings: () => void;
  onOpenCloudConnections?: () => void;
  onFlyoutOpenChange?: (open: boolean) => void;
  getViewportRightBoundary?: (anchor: HTMLElement | null) => number;
}

export function ModelSelector({
  translate: t,
  isMobile,
  shortcut: modelSelectorShortcut,
  onOpenModelSettings,
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
  menuPlacement = "above",
  buttonClassName = "",
  menuClassName = "",
  maxClosedWidth,
}: ModelSelectorProps & ModelSelectorHostProps) {
  const portalTheme = useCollaborationPortalTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const desktopMenuWrapperRef = useRef<HTMLDivElement>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);
  const simplePanelRef = useRef<HTMLDivElement>(null);
  const advancedPanelRef = useRef<HTMLDivElement>(null);
  const handledOpenSignalRef = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [closeReason, setCloseReason] =
    useState<ModelSelectorCloseReason>("dismiss");
  const [mobileQuery, setMobileQuery] = useState("");
  const [desktopMenuTop, setDesktopMenuTop] = useState(0);
  const [desktopMenuBottom, setDesktopMenuBottom] = useState<number | null>(
    null,
  );
  const [desktopMenuLeft, setDesktopMenuLeft] = useState(0);
  const [desktopMenuMaxHeight, setDesktopMenuMaxHeight] =
    useState(MAIN_MENU_MAX_HEIGHT);
  const [viewHeights, setViewHeights] = useState<
    Partial<Record<DesktopMenuView, number>>
  >({});
  const [desktopMenuView, setDesktopMenuView] =
    useState<DesktopMenuView>("simple");
  const [, setPowerSliderInteracting] = useState(false);
  const reportedOpenRef = useRef(open);
  const desktopFlyoutOpen = open && !isMobile;

  useEffect(() => {
    onFlyoutOpenChange?.(desktopFlyoutOpen);
    return () => onFlyoutOpenChange?.(false);
  }, [desktopFlyoutOpen, onFlyoutOpenChange]);

  useEffect(() => {
    if (reportedOpenRef.current === open) return;
    reportedOpenRef.current = open;
    onOpenChange?.(open, open ? undefined : closeReason);
  }, [closeReason, onOpenChange, open]);
  const familyGroups = useMemo(() => groupModelsByFamily(models), [models]);
  const defaultModel = useMemo(() => defaultNewChatModel(models), [models]);
  const desktopModels = useMemo(
    () => familyGroups.flatMap((group) => group.models),
    [familyGroups],
  );
  const powerPresets = useMemo(
    () => getModelPowerPresets(desktopModels, defaultModel),
    [defaultModel, desktopModels],
  );
  const defaultPowerPreset =
    powerPresets.find(
      (preset) =>
        preset.isDefault &&
        Boolean(
          defaultModel && isSameModelSelection(preset.owner, defaultModel),
        ),
    ) ??
    powerPresets.find(
      (preset) =>
        defaultModel && isSameModelSelection(preset.owner, defaultModel),
    ) ??
    powerPresets.find((preset) => preset.isDefault) ??
    powerPresets[0];
  const initiallySelectedPowerPreset =
    powerPresets.find((preset) =>
      preset.settings.some((setting) =>
        isSelectedPowerSetting(
          setting,
          selectedModel,
          selectedModelOptions.reasoning,
        ),
      ),
    ) ?? defaultPowerPreset;
  const [activePowerPresetKey, setActivePowerPresetKey] = useState(
    initiallySelectedPowerPreset?.key ?? "",
  );
  const activePowerPreset =
    powerPresets.find((preset) => preset.key === activePowerPresetKey) ??
    defaultPowerPreset;
  const powerSettings = activePowerPreset?.settings ?? [];
  const hasRecommendedDefault = powerPresets.length > 0;
  const selectedPowerSettingAvailable = powerSettings.some((setting) =>
    isSelectedPowerSetting(
      setting,
      selectedModel,
      selectedModelOptions.reasoning,
    ),
  );
  const selectedInDefaultSet =
    hasRecommendedDefault && selectedPowerSettingAvailable;
  const explicitModelSelectionRef = useRef(false);
  const [modelSelectionMode, setModelSelectionMode] =
    useState<ModelSelectionMode>(() =>
      selectedInDefaultSet ? "default" : "model",
    );
  const defaultModelSelected = Boolean(
    modelSelectionMode === "default" && selectedInDefaultSet,
  );
  const selectedFamily = selectedModel
    ? inferModelFamily(selectedModel)
    : familyGroups[0]?.config.id;
  const [activeFamilyId, setActiveFamilyId] = useState(selectedFamily ?? "");
  const displayedFamilyId =
    activeFamilyId || selectedFamily || familyGroups[0]?.config.id || "";
  const activeGroup =
    familyGroups.find((group) => group.config.id === displayedFamilyId) ??
    familyGroups[0];

  useEffect(() => {
    if (activePowerPreset) return;
    setActivePowerPresetKey(defaultPowerPreset?.key ?? "");
  }, [activePowerPreset, defaultPowerPreset]);

  useEffect(() => {
    if (!selectedInDefaultSet) {
      explicitModelSelectionRef.current = false;
      setModelSelectionMode("model");
      return;
    }
    if (!explicitModelSelectionRef.current) {
      setModelSelectionMode("default");
    }
  }, [selectedInDefaultSet]);

  useEffect(() => {
    if (!openSignal || disabled || open) return;
    if (handledOpenSignalRef.current === openSignal) return;

    handledOpenSignalRef.current = openSignal;
    buttonRef.current?.click();
  }, [disabled, open, openSignal]);

  const closeMenu = useCallback(
    (reason: ModelSelectorCloseReason = "dismiss") => {
      setCloseReason(reason);
      setOpen(false);
      setMobileQuery("");
      setDesktopMenuView("simple");
      setPowerSliderInteracting(false);
    },
    [setCloseReason, setMobileQuery, setOpen, setPowerSliderInteracting],
  );
  const openModelSettings = useCallback(() => {
    closeMenu();
    onOpenModelSettings();
  }, [closeMenu, onOpenModelSettings]);
  const openCloudConnectionSettings = useCallback(() => {
    closeMenu();
    onOpenCloudConnections?.();
  }, [closeMenu, onOpenCloudConnections]);
  const handleSelectModelOption = useCallback(
    (optionId: string, value: string) => {
      onSelectModelOption(optionId, value);
      if (isMobile) {
        closeMenu();
      }
    },
    [closeMenu, isMobile, onSelectModelOption],
  );
  const handleSelectModel = useCallback(
    (model: UnifiedModel | null) => {
      const selectionApplied = onSelectModel(model);
      if (isMobile && selectionApplied !== false) {
        closeMenu();
      }
      return selectionApplied;
    },
    [closeMenu, isMobile, onSelectModel],
  );
  const updateDesktopMenuLayout = useCallback(() => {
    const button = buttonRef.current;
    const menuPanel = menuPanelRef.current;
    if (!button || !menuPanel) return;

    const viewportTop = MODEL_SELECTOR_VIEWPORT_TOP;
    const viewportBottom = window.innerHeight - MODEL_SELECTOR_VIEWPORT_MARGIN;
    const maxAvailableHeight = Math.max(0, viewportBottom - viewportTop);
    const activePanelName =
      menuPanel.dataset.panel === "advanced" ? "advanced" : "simple";
    const activePanel = menuPanel.querySelector<HTMLElement>(
      `[data-model-picker-panel="${activePanelName}"]`,
    );
    const measuredHeight =
      activePanel?.getBoundingClientRect().height ??
      menuPanel.getBoundingClientRect().height;
    const naturalHeight =
      viewHeights[activePanelName] ||
      measuredHeight ||
      (activePanelName === "simple"
        ? SIMPLE_MENU_FALLBACK_HEIGHT
        : ADVANCED_MENU_FALLBACK_HEIGHT);
    const menuHeight = Math.min(
      MAIN_MENU_MAX_HEIGHT,
      maxAvailableHeight,
      naturalHeight,
    );
    const buttonRect = button.getBoundingClientRect();
    const preferredTop =
      menuPlacement === "below"
        ? buttonRect.bottom + MAIN_MENU_TRIGGER_GAP
        : buttonRect.top - MAIN_MENU_TRIGGER_GAP - menuHeight;
    const maxTop = viewportBottom - menuHeight;
    const clampedTop = Math.round(
      Math.max(viewportTop, Math.min(preferredTop, maxTop)),
    );
    const menuWidth =
      menuPanel.getBoundingClientRect().width || MAIN_MENU_WIDTH;
    const viewportRight =
      getViewportRightBoundary?.(button) ?? window.innerWidth;
    const maxLeft = viewportRight - MODEL_SELECTOR_VIEWPORT_MARGIN - menuWidth;
    const preferredLeft = buttonRect.right - menuWidth;
    const clampedLeft = Math.round(
      Math.max(
        MODEL_SELECTOR_VIEWPORT_MARGIN,
        Math.min(preferredLeft, maxLeft),
      ),
    );

    if (menuPlacement === "below") {
      setDesktopMenuTop(clampedTop);
      setDesktopMenuBottom(null);
    } else {
      setDesktopMenuBottom(
        Math.max(0, Math.round(window.innerHeight - clampedTop - menuHeight)),
      );
    }
    setDesktopMenuLeft(clampedLeft);
    setDesktopMenuMaxHeight(maxAvailableHeight);
  }, [getViewportRightBoundary, menuPlacement, viewHeights]);
  const activateMobileFamily = useCallback(
    (familyId: string) => {
      setActiveFamilyId((current) =>
        current === familyId ? current : familyId,
      );
    },
    [setActiveFamilyId],
  );

  useEffect(() => {
    if (!open || isMobile) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        containerRef.current?.contains(target) ||
        desktopMenuWrapperRef.current?.contains(target) ||
        (target instanceof Element &&
          target.closest('[data-model-selector-layer="true"]'))
      ) {
        return;
      }

      closeMenu();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [closeMenu, isMobile, open]);

  useEffect(() => {
    if (!open || isMobile) return;

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeMenu, isMobile, open]);

  const emptyModelLabel = t("workbench.no_models", "No models available");
  const selectedModelLabel = selectedModel
    ? getSelectedModelDisplayLabel(
        selectedModel,
        selectedModelOptions,
        (key, fallback) => t(key, fallback),
      )
    : familyGroups.length === 0
      ? emptyModelLabel
      : t("workbench.model_picker_title", "Select model");
  const selectedModelName = selectedModel
    ? getModelDisplayLabel(selectedModel, {}, (key, fallback) =>
        t(key, fallback),
      )
    : selectedModelLabel;
  const selectedModelSourceLabel = selectedModel
    ? isCodexOfficialModel(selectedModel)
      ? t("workbench.model_source_local_chatgpt", "本机 ChatGPT 账户")
      : isCloudModel(selectedModel)
        ? t("workbench.model_source_cloud", "云端模型")
        : t("workbench.model_source_custom", "自定义模型")
    : undefined;
  const controlsAboveFamilies = useMemo(() => {
    const controls = selectedModel
      ? getControlsForModel(selectedModel)
      : (activeGroup?.config.controls ?? []);
    return controls.filter(
      (control) =>
        isVisibleModelSelectorControl(control) &&
        (control.scope ?? "family") === "family",
    );
  }, [activeGroup, selectedModel]);
  const selectedModelControls = selectedModel
    ? getControlsForModel(selectedModel).filter(
        (control) =>
          isVisibleModelSelectorControl(control) && control.scope === "model",
      )
    : [];
  const controlsBelowModels = selectedModelControls.filter(
    (control) => control.placement === "belowModels",
  );
  const reasoningControl = controlsAboveFamilies.find(
    (control) => control.id === "reasoning",
  );
  const selectedReasoningValue =
    normalizeModelOptionValue("reasoning", selectedModelOptions.reasoning) ??
    reasoningControl?.defaultValue;
  const selectedReasoningOption = reasoningControl?.options.find(
    (option) => option.value === selectedReasoningValue,
  );
  const selectedReasoningLabel = selectedReasoningOption
    ? selectedReasoningOption.labelKey
      ? t(selectedReasoningOption.labelKey, selectedReasoningOption.label)
      : selectedReasoningOption.label
    : undefined;
  const ultraLabel =
    selectedReasoningValue === "ultra" && selectedReasoningOption
      ? selectedReasoningOption.labelKey
        ? t(selectedReasoningOption.labelKey, selectedReasoningOption.label)
        : selectedReasoningOption.label
      : undefined;
  const supportsReasoningControl = Boolean(reasoningControl);
  const speedControl = controlsBelowModels.find(
    (control) => control.id === "speed",
  );
  const fastModeState = desktopFastModeState(
    speedControl,
    selectedModelOptions,
  );
  const desktopReasoningControl = desktopModelControl(
    reasoningControl,
    selectedModel,
  );
  const desktopModelGroups = familyGroups;
  const localChatGptModelGroups = desktopModelGroups.flatMap((group) => {
    const localModels = group.models.filter(isCodexOfficialModel);
    return localModels.length > 0 ? [{ ...group, models: localModels }] : [];
  });
  const cloudDesktopModelGroups = desktopModelGroups.flatMap((group) => {
    const cloudModels = group.models.filter(
      (model) => isCloudModel(model) && !isCodexOfficialModel(model),
    );
    return cloudModels.length > 0 ? [{ ...group, models: cloudModels }] : [];
  });
  const customDesktopModelGroups = desktopModelGroups.flatMap((group) => {
    const customModels = group.models.filter(
      (model) => !isCloudModel(model) && !isCodexOfficialModel(model),
    );
    return customModels.length > 0 ? [{ ...group, models: customModels }] : [];
  });
  const useModelPowerSlider =
    modelSelectionMode === "default" && powerSettings.length >= 2;
  const advancedReasoningAvailable =
    useModelPowerSlider ||
    (modelSelectionMode === "model" &&
      (desktopReasoningControl?.options.length ?? 0) >= 2);
  const showExplicitEffortSelection =
    modelSelectionMode === "model" &&
    (desktopReasoningControl?.options.length ?? 0) >= 2;
  const resolvedDesktopMenuView = advancedReasoningAvailable
    ? desktopMenuView
    : "advanced";
  const selectedButtonLabel =
    open && resolvedDesktopMenuView === "simple"
      ? showExplicitEffortSelection
        ? t("workbench.select_reasoning_effort", "Select effort")
        : t("workbench.model_picker_title", "Select model")
      : selectedModelLabel;
  const activeViewHeight = viewHeights[resolvedDesktopMenuView];
  const displayedViewHeight = activeViewHeight
    ? Math.min(activeViewHeight, desktopMenuMaxHeight)
    : undefined;
  const buttonLabel = nextTurn
    ? t("workbench.next_turn_model", "Next · {{model}}", {
        model: selectedButtonLabel,
      })
    : selectedButtonLabel;
  useLayoutEffect(() => {
    if (!open || isMobile) return;
    const measure = () => {
      const simpleHeight = simplePanelRef.current?.offsetHeight;
      const advancedHeight = advancedPanelRef.current?.offsetHeight;
      setViewHeights((current) => {
        const next = {
          ...(simpleHeight ? { simple: simpleHeight } : {}),
          ...(advancedHeight ? { advanced: advancedHeight } : {}),
        };
        return current.simple === next.simple &&
          current.advanced === next.advanced
          ? current
          : next;
      });
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    if (simplePanelRef.current) observer?.observe(simplePanelRef.current);
    if (advancedPanelRef.current) observer?.observe(advancedPanelRef.current);
    return () => observer?.disconnect();
  }, [
    advancedReasoningAvailable,
    desktopModels.length,
    familyGroups.length,
    isMobile,
    open,
  ]);
  useLayoutEffect(() => {
    if (!open || isMobile) return;

    updateDesktopMenuLayout();
    window.addEventListener("resize", updateDesktopMenuLayout);
    return () => window.removeEventListener("resize", updateDesktopMenuLayout);
  }, [
    activeGroup?.models.length,
    resolvedDesktopMenuView,
    activeViewHeight,
    desktopModels.length,
    familyGroups.length,
    isMobile,
    open,
    updateDesktopMenuLayout,
  ]);

  const normalizedMobileQuery = mobileQuery.trim().toLowerCase();
  const resolveControlLabel = useCallback(
    (key: string, fallback: string) => t(key, fallback),
    [t],
  );
  const mobileModels = useMemo(() => {
    const modelsToFilter = activeGroup?.models ?? [];
    if (!normalizedMobileQuery) return modelsToFilter;

    return modelsToFilter.filter((model) => {
      const searchableText = [
        model.name,
        model.displayName,
        model.modelId,
        getModelDisplayLabel(model, selectedModelOptions, resolveControlLabel),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return searchableText.includes(normalizedMobileQuery);
    });
  }, [
    activeGroup,
    normalizedMobileQuery,
    resolveControlLabel,
    selectedModelOptions,
  ]);

  function renderDesktopModelOptions(modelsToRender: UnifiedModel[]) {
    return modelsToRender.map((model) => {
      const selected =
        modelSelectionMode === "model" &&
        isSameModelSelection(model, selectedModel);
      const modelDisabled = Boolean(model.compatibilityDisabled);
      const disabledMessage = modelDisabled
        ? modelCompatibilityDisabledMessage(
            model.compatibilityDisabledReason,
            resolveControlLabel,
          )
        : undefined;
      return (
        <button
          key={modelSelectionKey(model)}
          type="button"
          data-testid={`model-option-${getModelOptionId?.(model) ?? model.name}`}
          data-model-provider-id={codexProviderId(model)}
          role="menuitemradio"
          aria-checked={selected}
          aria-disabled={modelDisabled}
          title={disabledMessage}
          onClick={() => {
            if (modelDisabled) {
              onBlockedModelSelect?.(model, disabledMessage);
              return;
            }
            const selectionApplied = handleSelectModel(model);
            if (selectionApplied === false) {
              closeMenu("selection");
              return;
            }
            explicitModelSelectionRef.current = true;
            setModelSelectionMode("model");
            setDesktopMenuView("simple");
          }}
          className={[
            styles.modelItem,
            modelDisabled
              ? "cursor-not-allowed text-text-muted hover:bg-transparent focus-visible:bg-transparent"
              : "text-text-primary hover:bg-muted focus-visible:bg-muted",
          ].join(" ")}
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
                aria-label={t("workbench.environment_cloud", "云端")}
                className="h-3.5 w-3.5 shrink-0 text-text-muted"
              />
            )}
          </span>
          {selected && (
            <Check className="h-4 w-4 shrink-0 text-text-secondary" />
          )}
        </button>
      );
    });
  }

  function renderPowerPresetOptions(groupModels: UnifiedModel[]) {
    return powerPresets
      .filter((preset) =>
        groupModels.some((model) => isSameModelSelection(model, preset.owner)),
      )
      .map((preset) => {
        const isDefaultPreset = preset.key === defaultPowerPreset?.key;
        const selected =
          modelSelectionMode === "default" &&
          activePowerPreset?.key === preset.key &&
          selectedInDefaultSet;
        return (
          <button
            key={preset.key}
            type="button"
            data-testid={
              isDefaultPreset
                ? "model-option-default"
                : `model-option-preset-${preset.name}`
            }
            data-model-preset={preset.name}
            role="menuitemradio"
            aria-checked={selected}
            onClick={() => selectPowerPreset(preset)}
            className={`${styles.defaultItem} transition-colors hover:bg-muted focus-visible:bg-muted`}
          >
            <span className="min-w-0 flex-1">
              <span className={styles.defaultTitle}>
                {isDefaultPreset
                  ? t("workbench.default_model", "默认")
                  : preset.label}
              </span>
              <span className={styles.defaultDescription}>
                {preset.description ??
                  (isDefaultPreset
                    ? t("workbench.model_recommended_set", "推荐模型集")
                    : t("workbench.model_set", "模型集"))}
              </span>
            </span>
            {selected && (
              <Check className="h-4 w-4 shrink-0 text-text-secondary" />
            )}
          </button>
        );
      });
  }

  function renderAdvancedModelSource(
    testId: string,
    label: string,
    groups: typeof desktopModelGroups,
    showFamilyLabels: boolean,
  ) {
    if (groups.length === 0) return null;
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
    );
  }

  function renderMobileControlSection(control: ModelControlConfig) {
    return (
      <section key={control.id} className="space-y-2">
        <h3 className="px-1 text-xs font-semibold text-text-muted">
          {control.labelKey
            ? t(control.labelKey, control.label)
            : control.label}
        </h3>
        <div className="scrollbar-none flex gap-2 overflow-x-auto pb-1">
          {control.options
            .slice()
            .sort((a, b) => a.order - b.order)
            .map((option) => {
              const selected =
                selectedControlOption(control, selectedModelOptions)?.value ===
                option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  data-testid={`model-control-${control.id}-${option.value}`}
                  onClick={() =>
                    handleSelectModelOption(control.id, option.value)
                  }
                  className={[
                    "flex h-11 min-w-[44px] shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium",
                    selected
                      ? "border-text-primary bg-text-primary text-background"
                      : "border-border bg-surface text-text-secondary",
                  ].join(" ")}
                >
                  <span>
                    {option.labelKey
                      ? t(option.labelKey, option.label)
                      : option.label}
                  </span>
                  {selected && <Check className="h-4 w-4" />}
                </button>
              );
            })}
        </div>
      </section>
    );
  }

  function selectPowerPreset(preset: (typeof powerPresets)[number]) {
    const ownerReasoningControl = getControlsForModel(preset.owner).find(
      (control) => control.id === "reasoning",
    );
    const selectedSetting =
      preset.settings.find((setting) =>
        isSelectedPowerSetting(
          setting,
          preset.owner,
          ownerReasoningControl?.defaultValue,
        ),
      ) ?? preset.settings[0];
    if (!selectedSetting) return;
    const speedControl = getControlsForModel(selectedSetting.model).find(
      (control) => control.id === "speed",
    );
    const defaultOptions = modelPowerOptions(selectedSetting, {
      ...(speedControl?.defaultValue
        ? { speed: speedControl.defaultValue }
        : {}),
    });
    if (onSelectModelAndOptions) {
      onSelectModelAndOptions(selectedSetting.model, defaultOptions);
    } else {
      if (handleSelectModel(selectedSetting.model) === false) {
        closeMenu("selection");
        return;
      }
      if (selectedSetting.reasoningEffort !== undefined) {
        handleSelectModelOption("reasoning", selectedSetting.reasoningEffort);
      }
      if (speedControl?.defaultValue) {
        handleSelectModelOption("speed", speedControl.defaultValue);
      }
    }
    explicitModelSelectionRef.current = false;
    setActivePowerPresetKey(preset.key);
    setModelSelectionMode("default");
    setDesktopMenuView("simple");
  }

  function selectDefaultModel() {
    if (defaultPowerPreset) selectPowerPreset(defaultPowerPreset);
  }

  return (
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
          handleSelectModel={handleSelectModel}
          closeMenu={closeMenu}
          emptyState={
            <ModelSelectorEmptyState
              translate={t}
              mobile
              onOpenModelSettings={openModelSettings}
              onOpenCloudConnections={
                onOpenCloudConnections ? openCloudConnectionSettings : undefined
              }
            />
          }
        />
      )}
      {open &&
        !isMobile &&
        createPortal(
          <div
            {...portalTheme}
            ref={desktopMenuWrapperRef}
            style={{
              ...portalTheme.style,
              left: desktopMenuLeft,
              top: desktopMenuBottom === null ? desktopMenuTop : undefined,
              bottom: desktopMenuBottom ?? undefined,
            }}
            data-model-selector-layer="true"
            data-embedded-browser-occlusion
            className={cn(
              portalTheme.className,
              "fixed z-system-popover w-[254px]",
              styles.menuWrapper,
              menuClassName,
            )}
          >
            <div
              ref={menuPanelRef}
              data-testid="model-selector-menu"
              data-panel={resolvedDesktopMenuView}
              data-enter-animation="main"
              style={{ maxHeight: desktopMenuMaxHeight }}
              className={cn(
                "w-[254px] shrink-0 overflow-hidden rounded-2xl bg-popover",
                styles.mainMenu,
              )}
            >
              {desktopModels.length === 0 && (
                <ModelSelectorEmptyState
                  translate={t}
                  onOpenModelSettings={openModelSettings}
                  onOpenCloudConnections={
                    onOpenCloudConnections
                      ? openCloudConnectionSettings
                      : undefined
                  }
                />
              )}
              {desktopModels.length > 0 ? (
                <div
                  className={styles.viewContainer}
                  data-model-picker-view={resolvedDesktopMenuView}
                  style={{
                    height: displayedViewHeight,
                  }}
                >
                  {advancedReasoningAvailable ? (
                    <div
                      aria-hidden={resolvedDesktopMenuView === "advanced"}
                      className={styles.viewTrack}
                      data-active={resolvedDesktopMenuView === "simple"}
                      inert={
                        resolvedDesktopMenuView === "advanced"
                          ? true
                          : undefined
                      }
                    >
                      <div
                        ref={simplePanelRef}
                        data-model-picker-panel="simple"
                        className="flex w-full flex-col p-1"
                      >
                        <div
                          data-testid="model-simple-header"
                          data-explicit-model={!defaultModelSelected}
                          className="relative flex min-h-9 items-center justify-center px-2"
                        >
                          {fastModeState.available ? (
                            <button
                              type="button"
                              data-testid="model-advanced-fast-mode-toggle"
                              aria-pressed={fastModeState.enabled}
                              aria-label={t("workbench.speed_fast", "快速")}
                              onClick={() =>
                                handleSelectModelOption(
                                  "speed",
                                  fastModeState.nextValue,
                                )
                              }
                              data-enabled={
                                fastModeState.enabled ? "true" : "false"
                              }
                              className={`${styles.fastModeToggle} absolute left-0 top-0 flex h-8 w-8 items-center justify-center rounded-lg hover:bg-muted focus-visible:bg-muted focus-visible:outline-none`}
                            >
                              <FastModeIcon className="h-4 w-4" />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            data-testid="model-advanced-toggle"
                            onClick={() => setDesktopMenuView("advanced")}
                            className="flex min-w-0 max-w-full flex-col items-center justify-center rounded-md px-1 py-0.5 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                          >
                            {selectedModelSourceLabel ? (
                              <span
                                data-testid="model-simple-source"
                                className="min-w-0 truncate text-xs font-normal text-text-muted"
                              >
                                {selectedModelSourceLabel}
                              </span>
                            ) : null}
                            <span className="flex min-w-0 items-center text-base font-medium text-text-primary">
                              <span className="min-w-0 truncate">
                                {selectedModelName}
                              </span>
                              {selectedReasoningLabel ? (
                                <span
                                  className={[
                                    "ml-1 shrink-0",
                                    showExplicitEffortSelection
                                      ? "text-reasoning-standard"
                                      : "text-text-muted",
                                  ].join(" ")}
                                >
                                  {selectedReasoningLabel}
                                </span>
                              ) : null}
                              <ChevronRight className="ml-1 h-4 w-4 shrink-0 text-text-muted" />
                            </span>
                          </button>
                          {hasRecommendedDefault &&
                          !defaultModelSelected &&
                          defaultPowerPreset ? (
                            <button
                              type="button"
                              data-testid="model-reset-default-button"
                              aria-label={t(
                                "workbench.reset_default_model_settings",
                                "重置模型设置",
                              )}
                              title={t(
                                "workbench.reset_default_model_settings",
                                "重置模型设置",
                              )}
                              onClick={selectDefaultModel}
                              className="absolute right-0 top-0 flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-text-primary focus-visible:bg-muted focus-visible:outline-none"
                            >
                              <RotateCcw className="h-4 w-4" />
                            </button>
                          ) : null}
                        </div>
                        {(useModelPowerSlider || desktopReasoningControl) &&
                        advancedReasoningAvailable ? (
                          <div
                            data-testid="model-advanced-panel"
                            className="min-h-9"
                          >
                            {useModelPowerSlider ? (
                              <ModelPowerSlider
                                translate={t}
                                powerSettings={powerSettings}
                                selectedModel={selectedModel}
                                selectedModelOptions={selectedModelOptions}
                                onSelectModel={handleSelectModel}
                                onSelectModelAndOptions={
                                  onSelectModelAndOptions
                                }
                                onSelectModelOption={handleSelectModelOption}
                                onInteractionChange={setPowerSliderInteracting}
                                accentPulse={fastModeState.enabled}
                                compact
                              />
                            ) : desktopReasoningControl ? (
                              <ReasoningSlider
                                translate={t}
                                control={desktopReasoningControl}
                                selectedModelOptions={selectedModelOptions}
                                onSelectOption={handleSelectModelOption}
                                compact
                                clearSubmenuOnHover={false}
                                onInteractionChange={setPowerSliderInteracting}
                                accentPulse={fastModeState.enabled}
                              />
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  <div
                    aria-hidden={resolvedDesktopMenuView === "simple"}
                    className={styles.advancedViewTrack}
                    data-active={resolvedDesktopMenuView === "advanced"}
                    inert={
                      resolvedDesktopMenuView === "simple" ? true : undefined
                    }
                  >
                    <div
                      ref={advancedPanelRef}
                      data-model-picker-panel="advanced"
                      className={cn(styles.advancedPanel, "max-h-[316px]")}
                    >
                      <div className={styles.sectionLabel}>
                        {t("workbench.model_picker_title", "选择模型")}
                      </div>
                      <div>
                        {renderAdvancedModelSource(
                          "model-source-local-chatgpt",
                          t(
                            "workbench.model_source_local_chatgpt",
                            "本机 ChatGPT 账户",
                          ),
                          localChatGptModelGroups,
                          false,
                        )}
                        {renderAdvancedModelSource(
                          "model-source-cloud",
                          t("workbench.model_source_cloud", "云端模型"),
                          cloudDesktopModelGroups,
                          true,
                        )}
                        {renderAdvancedModelSource(
                          "model-source-custom",
                          t("workbench.model_source_custom", "自定义模型"),
                          customDesktopModelGroups,
                          true,
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>,
          document.body,
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
            ? `${t("workbench.model_selector")}, ${t("workbench.speed_fast", "快速")}`
            : t("workbench.model_selector")
        }
        tooltipLabel={t("workbench.model_picker_title", "选择模型")}
        modelProviderId={codexProviderId(selectedModel)}
        buttonClassName={buttonClassName}
        maxClosedWidth={maxClosedWidth}
        onToggle={() => {
          if (disabled) return;
          if (open) {
            closeMenu();
            return;
          }
          setCloseReason("dismiss");
          setDesktopMenuView("simple");
          setPowerSliderInteracting(false);
          setOpen(true);
        }}
      />
    </div>
  );
}
