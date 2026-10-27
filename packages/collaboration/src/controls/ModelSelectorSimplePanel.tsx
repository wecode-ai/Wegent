import type { Ref } from "react";
import type { CollaborationTranslate } from "../i18n";
import type { ModelSelectorProps } from "./model-selector-types";
import type { ModelControlConfig } from "./model-ui";
import type {
  ModelPowerPreset,
  desktopFastModeState,
} from "./model-selector-utils";
import { ModelSelectorSummary } from "./ModelSelectorSummary";
import { ModelPowerSlider } from "./ModelPowerSlider";
import { ReasoningSlider } from "./ReasoningSlider";

interface ModelSelectorSimplePanelProps extends Pick<
  ModelSelectorProps,
  | "selectedModel"
  | "selectedModelOptions"
  | "onSelectModel"
  | "onSelectModelAndOptions"
  | "onSelectModelOption"
> {
  translate: CollaborationTranslate;
  panelRef: Ref<HTMLDivElement>;
  maxHeight: number;
  sourceLabel?: string;
  modelName: string;
  reasoningLabel?: string;
  preset?: ModelPowerPreset;
  presetSelected: boolean;
  resetAvailable: boolean;
  fastModeState: ReturnType<typeof desktopFastModeState>;
  control?: ModelControlConfig;
  onOpenModels: () => void;
  onReset: () => void;
  onInteractionChange: (interacting: boolean) => void;
}

export function ModelSelectorSimplePanel({
  translate: t,
  panelRef,
  maxHeight,
  sourceLabel,
  modelName,
  reasoningLabel,
  preset,
  presetSelected,
  resetAvailable,
  fastModeState,
  control,
  onOpenModels,
  onReset,
  onInteractionChange,
  selectedModel,
  selectedModelOptions,
  onSelectModel,
  onSelectModelAndOptions,
  onSelectModelOption,
}: ModelSelectorSimplePanelProps) {
  const powerSettings = preset?.settings ?? [];
  const usePowerSlider = presetSelected && powerSettings.length >= 2;
  const presetLabel =
    presetSelected && preset
      ? preset.name === "recommended"
        ? t("workbench.model_recommended_set", "推荐模型集")
        : preset.label
      : undefined;

  return (
    <div
      ref={panelRef}
      data-model-picker-panel="simple"
      style={{ maxHeight }}
      className="flex w-full flex-col overflow-y-auto p-1"
    >
      <ModelSelectorSummary
        translate={t}
        hasSelection={Boolean(selectedModel)}
        sourceLabel={sourceLabel}
        modelName={modelName}
        reasoningLabel={reasoningLabel}
        presetLabel={presetLabel}
        fastModeState={fastModeState}
        onToggleFastMode={() =>
          onSelectModelOption("speed", fastModeState.nextValue)
        }
        onOpenModels={onOpenModels}
        onReset={resetAvailable ? onReset : undefined}
      />
      <div data-testid="model-advanced-panel" className="min-h-9">
        {usePowerSlider ? (
          <ModelPowerSlider
            translate={t}
            powerSettings={powerSettings}
            selectedModel={selectedModel}
            selectedModelOptions={selectedModelOptions}
            onSelectModel={onSelectModel}
            onSelectModelAndOptions={onSelectModelAndOptions}
            onSelectModelOption={onSelectModelOption}
            onInteractionChange={onInteractionChange}
            accentPulse={fastModeState.enabled}
            compact
          />
        ) : control ? (
          <ReasoningSlider
            translate={t}
            control={control}
            selectedModelOptions={selectedModelOptions}
            onSelectOption={onSelectModelOption}
            compact
            clearSubmenuOnHover={false}
            onInteractionChange={onInteractionChange}
            accentPulse={fastModeState.enabled}
          />
        ) : null}
      </div>
      {selectedModel && (
        <p
          data-testid="model-slider-description"
          className="px-3 pb-2 pt-1 text-center text-xs text-text-muted text-balance"
        >
          {presetSelected
            ? t(
                "workbench.model_set_slider_hint",
                "调整档位会切换模型及推理强度",
              )
            : t(
                "workbench.fixed_model_slider_hint",
                "仅调整当前模型的推理强度",
              )}
        </p>
      )}
    </div>
  );
}
