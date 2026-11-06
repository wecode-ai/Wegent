import type { ModelControlConfig, ModelControlOption } from "./model-ui";

export const MODEL_INTERFACE_REASONING_OPTIONS: Record<
  string,
  Pick<ModelControlOption, "label" | "labelKey">
> = {
  none: {
    label: "None",
    labelKey: "workbench.local_model_reasoning_none",
  },
  minimal: {
    label: "Minimal",
    labelKey: "workbench.local_model_reasoning_minimal",
  },
  low: {
    label: "Low",
    labelKey: "workbench.local_model_reasoning_low",
  },
  medium: {
    label: "Medium",
    labelKey: "workbench.local_model_reasoning_medium",
  },
  high: {
    label: "High",
    labelKey: "workbench.local_model_reasoning_high",
  },
  xhigh: {
    label: "Extra high",
    labelKey: "workbench.local_model_reasoning_xhigh",
  },
  max: {
    label: "Maximum",
    labelKey: "workbench.local_model_reasoning_max",
  },
  ultra: {
    label: "Ultra",
    labelKey: "workbench.local_model_reasoning_ultra",
  },
};

export const OPENAI_REASONING_CONTROL: ModelControlConfig = {
  id: "reasoning",
  label: "Reasoning",
  labelKey: "workbench.reasoning_level",
  defaultValue: "high",
  placement: "aboveModels",
  scope: "family",
  includeInLabel: "never",
  options: [
    {
      value: "low",
      label: "Low",
      labelKey: "workbench.intelligence_low",
      order: 10,
    },
    {
      value: "medium",
      label: "Medium",
      labelKey: "workbench.intelligence_medium",
      order: 20,
    },
    {
      value: "high",
      label: "High",
      labelKey: "workbench.intelligence_high",
      order: 30,
    },
    {
      value: "xhigh",
      label: "Extra High",
      labelKey: "workbench.intelligence_xhigh",
      order: 40,
    },
    {
      value: "max",
      label: "Maximum",
      labelKey: "workbench.intelligence_max",
      order: 50,
    },
    {
      value: "ultra",
      label: "Ultra",
      labelKey: "workbench.intelligence_ultra",
      description: "Faster, uses more quota",
      descriptionKey: "workbench.reasoning_ultra_description",
      order: 60,
    },
  ],
};

export function reasoningOption(value: string): ModelControlOption {
  return (
    OPENAI_REASONING_CONTROL.options.find(
      (option) => option.value === value,
    ) ?? {
      value,
      ...(MODEL_INTERFACE_REASONING_OPTIONS[value] ?? { label: value }),
      order: 0,
    }
  );
}
