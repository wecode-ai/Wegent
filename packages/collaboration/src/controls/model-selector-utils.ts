import {
  type ModelControlConfig,
  getControlsForModel,
  hasCatalogReasoningEfforts,
  isCodexOfficialModel,
  isModelInterfaceModel,
  isModelPickerDefault,
  isSameModelSelection,
  normalizeModelOptionValue,
} from "./model-ui";
import type {
  ModelCompatibilityDisabledReason,
  ModelOptions,
  UnifiedModel,
} from "@wegent/chat-core/models";

export function isVisibleModelSelectorControl(
  control: ModelControlConfig,
): boolean {
  return control.id !== "collaborationMode";
}

export function isCodexDefaultModel(model: UnifiedModel | null): boolean {
  return Boolean(
    model &&
    isCodexOfficialModel(model) &&
    model.config?.codexIsDefault === true,
  );
}

export interface ModelPowerSetting {
  id: string;
  model: UnifiedModel;
  reasoningEffort?: string;
}

export interface ModelPowerPreset {
  key: string;
  name: string;
  label: string;
  description?: string;
  owner: UnifiedModel;
  settings: ModelPowerSetting[];
  isDefault: boolean;
}

export function modelPowerOptions(
  setting: ModelPowerSetting,
  options: ModelOptions = {},
): ModelOptions {
  const nextOptions = { ...options };
  delete nextOptions.reasoning;
  if (setting.reasoningEffort !== undefined) {
    nextOptions.reasoning = setting.reasoningEffort;
  }
  return nextOptions;
}

const PRIMARY_POWER_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

interface SliderModelConfig {
  model?: string;
  modelName?: string;
  modelType?: string;
  namespace?: string;
  resourceUserId?: number;
  reasoningEffort?: string;
  reasoningEfforts?: string[];
  reasoning_effort?: string;
}

interface SliderPresetConfig {
  name?: string;
  label?: string;
  description?: string;
  models?: SliderModelConfig[];
}

interface SliderModelsConfig {
  defaultPreset?: string;
  presets?: SliderPresetConfig[];
}

function normalizedModelId(model: UnifiedModel): string {
  return (model.modelId || model.name).trim().toLowerCase();
}

function reasoningEfforts(model: UnifiedModel): Set<string> {
  const control = getControlsForModel(model).find(
    (candidate) => candidate.id === "reasoning",
  );
  return new Set(control?.options.map((option) => option.value) ?? []);
}

function modelPowerSetting(
  model: UnifiedModel,
  reasoningEffort?: string,
): ModelPowerSetting {
  return {
    id: reasoningEffort
      ? `${normalizedModelId(model)}:${reasoningEffort}`
      : normalizedModelId(model),
    model,
    reasoningEffort,
  };
}

function sliderModelsConfig(model: UnifiedModel): SliderModelsConfig | null {
  const ui =
    model.config?.ui &&
    typeof model.config.ui === "object" &&
    !Array.isArray(model.config.ui)
      ? (model.config.ui as Record<string, unknown>)
      : {};
  const configured = ui.sliderModelsConfig ?? model.config?.sliderModelsConfig;
  if (
    !configured ||
    typeof configured !== "object" ||
    Array.isArray(configured)
  ) {
    return null;
  }
  return configured as SliderModelsConfig;
}

function matchesSliderModelConfig(
  model: UnifiedModel,
  config: SliderModelConfig,
): boolean {
  const reference = config.modelName ?? config.model;
  if (
    typeof reference !== "string" ||
    !reference.trim() ||
    ![model.name, model.modelId].some(
      (candidate) =>
        candidate?.trim().toLowerCase() === reference.trim().toLowerCase(),
    )
  ) {
    return false;
  }
  if (config.modelType && config.modelType !== model.type) return false;
  if (config.namespace && config.namespace !== model.namespace) return false;
  if (
    config.resourceUserId !== undefined &&
    config.resourceUserId !== model.resourceUserId
  ) {
    return false;
  }
  return true;
}

function configuredPowerPresets(
  models: UnifiedModel[],
  configOwner: UnifiedModel,
): ModelPowerPreset[] {
  const configured = sliderModelsConfig(configOwner);
  if (!Array.isArray(configured?.presets)) return [];
  const defaultPreset = configured.defaultPreset?.trim();
  const seenNames = new Set<string>();

  return configured.presets.flatMap((preset) => {
    if (!preset || typeof preset !== "object" || Array.isArray(preset)) {
      return [];
    }
    const name = preset.name?.trim();
    if (!name || seenNames.has(name) || !Array.isArray(preset.models))
      return [];
    seenNames.add(name);

    const settings: ModelPowerSetting[] = [];
    for (const config of preset.models) {
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        continue;
      }
      const model = models.find(
        (candidate) =>
          !candidate.compatibilityDisabled &&
          matchesSliderModelConfig(candidate, config),
      );
      if (!model) continue;
      if (
        config.reasoningEfforts === undefined &&
        config.reasoningEffort === undefined &&
        config.reasoning_effort === undefined
      ) {
        settings.push(modelPowerSetting(model));
        continue;
      }
      const supportedEfforts = reasoningEfforts(model);
      const configuredEfforts = Array.isArray(config.reasoningEfforts)
        ? config.reasoningEfforts
        : typeof config.reasoningEffort === "string"
          ? [config.reasoningEffort]
          : typeof config.reasoning_effort === "string"
            ? [config.reasoning_effort]
            : [];
      for (const configuredEffort of configuredEfforts) {
        const effort = normalizeModelOptionValue("reasoning", configuredEffort);
        if (!effort || !supportedEfforts.has(effort)) continue;
        settings.push(modelPowerSetting(model, effort));
      }
    }
    if (settings.length === 0) return [];

    return [
      {
        key: `${configOwner.type}:${configOwner.name}:${name}`,
        name,
        label: preset.label?.trim() || name,
        description: preset.description?.trim() || undefined,
        owner: configOwner,
        settings,
        isDefault: name === defaultPreset,
      },
    ];
  });
}

function fallbackCodexPowerSettings(
  models: UnifiedModel[],
): ModelPowerSetting[] {
  const officialModels = models.filter(
    (model) => !model.compatibilityDisabled && isCodexOfficialModel(model),
  );
  const primaryModel =
    officialModels.find((model) => model.config?.codexIsDefault === true) ??
    officialModels[0];
  if (!primaryModel) return [];

  const primaryEfforts = reasoningEfforts(primaryModel);
  const primarySettings = PRIMARY_POWER_EFFORTS.filter((effort) =>
    primaryEfforts.has(effort),
  ).map((effort) => modelPowerSetting(primaryModel, effort));
  const secondaryModel = officialModels.find(
    (model) =>
      !isSameModelSelection(model, primaryModel) &&
      /(?:^|[-\s])luna(?:$|[-\s])/i.test(normalizedModelId(model)),
  );
  if (!secondaryModel) return primarySettings;

  const secondaryControl = getControlsForModel(secondaryModel).find(
    (control) => control.id === "reasoning",
  );
  const secondaryEfforts = reasoningEfforts(secondaryModel);
  const secondaryEffort =
    secondaryControl?.defaultValue &&
    secondaryEfforts.has(secondaryControl.defaultValue)
      ? secondaryControl.defaultValue
      : secondaryEfforts.has("high")
        ? "high"
        : secondaryControl?.options[0]?.value;

  return secondaryEffort
    ? [modelPowerSetting(secondaryModel, secondaryEffort), ...primarySettings]
    : primarySettings;
}

export function getModelPowerSettings(
  models: UnifiedModel[],
  defaultModel?: UnifiedModel | null,
): ModelPowerSetting[] {
  return getModelPowerPresets(models, defaultModel)[0]?.settings ?? [];
}

export function getModelPowerPresets(
  models: UnifiedModel[],
  defaultModel?: UnifiedModel | null,
): ModelPowerPreset[] {
  const hasConfiguredPresets = models.some((model) =>
    Array.isArray(sliderModelsConfig(model)?.presets),
  );
  const configured = models.flatMap((model) =>
    configuredPowerPresets(models, model),
  );
  if (configured.length > 0) {
    const hasExplicitDefault = configured.some((preset) => preset.isDefault);
    return configured.map((preset, index) => ({
      ...preset,
      isDefault:
        preset.isDefault ||
        (!hasExplicitDefault &&
          index === 0 &&
          Boolean(
            defaultModel && isSameModelSelection(preset.owner, defaultModel),
          )),
    }));
  }
  if (hasConfiguredPresets) return [];

  const owner = models.find((model) => isModelPickerDefault(model));
  const settings = fallbackCodexPowerSettings(models);
  return owner && settings.length > 0
    ? [
        {
          key: `${owner.type}:${owner.name}:recommended`,
          name: "recommended",
          label: "推荐",
          owner,
          settings,
          isDefault: true,
        },
      ]
    : [];
}

export function isSelectedPowerSetting(
  setting: ModelPowerSetting,
  selectedModel: UnifiedModel | null,
  reasoningEffort?: string,
): boolean {
  return Boolean(
    selectedModel &&
    isSameModelSelection(selectedModel, setting.model) &&
    (setting.reasoningEffort === undefined ||
      normalizeModelOptionValue("reasoning", reasoningEffort) ===
        setting.reasoningEffort),
  );
}

export function desktopModelControl(
  control: ModelControlConfig | undefined,
  model: UnifiedModel | null,
): ModelControlConfig | undefined {
  if (!control || control.id !== "reasoning") {
    return control;
  }
  if (
    isModelInterfaceModel(model) ||
    (model && hasCatalogReasoningEfforts(model))
  ) {
    return control;
  }

  return {
    ...control,
    options: control.options.filter((option) => option.value !== "max"),
  };
}

export function selectedControlOption(
  control: ModelControlConfig,
  options: ModelOptions,
) {
  const requestedValue = normalizeModelOptionValue(
    control.id,
    options[control.id],
  );
  return (
    control.options.find((option) => option.value === requestedValue) ??
    control.options.find((option) => option.value === control.defaultValue) ??
    control.options[0]
  );
}

export function desktopFastModeState(
  control: ModelControlConfig | undefined,
  options: ModelOptions,
) {
  const selectedValue = control
    ? selectedControlOption(control, options)?.value
    : undefined;
  const available = Boolean(
    control?.options.some((option) => option.value === "fast") &&
    control.options.some((option) => option.value === "standard"),
  );
  return {
    available,
    enabled: selectedValue === "fast",
    nextValue: selectedValue === "fast" ? "standard" : "fast",
  };
}

export function modelCompatibilityDisabledMessage(
  reason: ModelCompatibilityDisabledReason | undefined,
  resolveLabel: (key: string, fallback: string) => string,
): string {
  if (reason === "missing_current_runtime_family") {
    return resolveLabel(
      "workbench.model_disabled_missing_current_runtime_family",
      "Current model is missing runtime.family",
    );
  }
  if (reason === "missing_target_runtime_family") {
    return resolveLabel(
      "workbench.model_disabled_missing_target_runtime_family",
      "This model is missing runtime.family",
    );
  }
  if (reason === "unavailable") {
    return resolveLabel(
      "workbench.model_disabled_unavailable",
      "This model is unavailable",
    );
  }
  return resolveLabel(
    "workbench.model_disabled_runtime_family_mismatch",
    "Incompatible with the current model protocol",
  );
}

export function isCloudModel(model: UnifiedModel): boolean {
  return model.provider !== "local";
}

export function codexProviderId(
  model: UnifiedModel | null,
): string | undefined {
  const providerId = model?.config?.codexProviderId;
  return typeof providerId === "string" ? providerId : undefined;
}
