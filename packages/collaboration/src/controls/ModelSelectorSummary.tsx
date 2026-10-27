import { ChevronRight, RotateCcw } from "lucide-react";
import type { CollaborationTranslate } from "../i18n";
import { FastModeIcon } from "./FastModeIcon";
import styles from "./ModelSelector.module.css";

interface ModelSelectorSummaryProps {
  translate: CollaborationTranslate;
  hasSelection: boolean;
  sourceLabel?: string;
  modelName: string;
  reasoningLabel?: string;
  presetLabel?: string;
  fastModeState: { available: boolean; enabled: boolean };
  onToggleFastMode: () => void;
  onOpenModels: () => void;
  onReset?: () => void;
}

export function ModelSelectorSummary({
  translate: t,
  hasSelection,
  sourceLabel,
  modelName,
  reasoningLabel,
  presetLabel,
  fastModeState,
  onToggleFastMode,
  onOpenModels,
  onReset,
}: ModelSelectorSummaryProps) {
  return (
    <div
      data-testid="model-simple-header"
      data-explicit-model={!presetLabel}
      className="px-2 pt-1"
    >
      <div className="flex min-h-7 items-center justify-between gap-2">
        <span
          data-testid="model-simple-source"
          className="min-w-0 text-xs text-text-muted [overflow-wrap:anywhere]"
        >
          {sourceLabel}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {fastModeState.available && (
            <button
              type="button"
              data-testid="model-advanced-fast-mode-toggle"
              aria-pressed={fastModeState.enabled}
              aria-label={t("workbench.speed_fast", "快速")}
              title={t("workbench.speed_fast", "快速")}
              onClick={onToggleFastMode}
              data-enabled={fastModeState.enabled ? "true" : "false"}
              className={`${styles.fastModeToggle} flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring`}
            >
              <FastModeIcon className="h-4 w-4" />
            </button>
          )}
          {onReset && (
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
              onClick={onReset}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      <button
        type="button"
        data-testid="model-advanced-toggle"
        onClick={onOpenModels}
        className="my-1 flex w-full min-w-0 flex-col items-center gap-1 rounded-lg px-2 py-1 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        {hasSelection && (
          <span
            data-testid="model-selection-mode"
            className="max-w-full rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-text-secondary [overflow-wrap:anywhere]"
          >
            {presetLabel ?? t("workbench.model_fixed", "固定模型")}
          </span>
        )}
        <span className="flex max-w-full items-center gap-1 text-base font-medium text-text-primary">
          <span
            data-testid="model-simple-name"
            className="min-w-0 text-balance [overflow-wrap:anywhere]"
          >
            {modelName}
          </span>
          {reasoningLabel && (
            <span className="shrink-0 whitespace-nowrap text-text-muted">
              {reasoningLabel}
            </span>
          )}
          <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
        </span>
      </button>
    </div>
  );
}
