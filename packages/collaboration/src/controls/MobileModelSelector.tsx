import { Check, Cloud, Search, X } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ModelOptions, UnifiedModel } from "@wegent/chat-core/models";
import type { CollaborationTranslate } from "../i18n";
import { useCollaborationPortalTheme } from "../theme";
import { ModelAutomaticReasoningOption } from "./ModelAutomaticReasoningOption";
import {
  getModelDisplayLabel,
  groupModelsByFamily,
  type ModelControlConfig,
} from "./model-ui";
import {
  codexProviderId,
  isCloudModel,
  modelCompatibilityDisabledMessage,
} from "./model-selector-utils";
import {
  handleMobileModelSelectorDialogKeyDown,
  useMobileModelSelectorFocus,
} from "./model-selector-mobile-utils";

interface MobileModelSelectorProps {
  translate: CollaborationTranslate;
  buttonLabel: string;
  mobileQuery: string;
  setMobileQuery(value: string): void;
  controlsAboveFamilies: ModelControlConfig[];
  controlsBelowModels: ModelControlConfig[];
  renderMobileControlSection(control: ModelControlConfig): ReactNode;
  supportsReasoningControl: boolean;
  familyGroups: ReturnType<typeof groupModelsByFamily>;
  activeGroup:
    | ReturnType<typeof groupModelsByFamily>[number]
    | null
    | undefined;
  activateMobileFamily(id: string): void;
  mobileModels: UnifiedModel[];
  selectedModel: UnifiedModel | null;
  selectedModelOptions: ModelOptions;
  onBlockedModelSelect?: (model: UnifiedModel, message?: string) => void;
  handleSelectModel(model: UnifiedModel | null): void;
  closeMenu(): void;
  emptyState: ReactNode;
}

export function MobileModelSelector({
  translate: t,
  buttonLabel,
  mobileQuery,
  setMobileQuery,
  controlsAboveFamilies,
  controlsBelowModels,
  renderMobileControlSection,
  supportsReasoningControl,
  familyGroups,
  activeGroup,
  activateMobileFamily,
  mobileModels,
  selectedModel,
  selectedModelOptions,
  onBlockedModelSelect,
  handleSelectModel,
  closeMenu,
  emptyState,
}: MobileModelSelectorProps) {
  const portalTheme = useCollaborationPortalTheme();
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const mobileCloseButtonRef = useRef<HTMLButtonElement>(null);
  useMobileModelSelectorFocus(true, true, mobileCloseButtonRef);
  const resolveControlLabel = (key: string, fallback: string) =>
    t(key, fallback);

  return createPortal(
    <div
      {...portalTheme}
      className={`${portalTheme.className} fixed inset-0 z-modal bg-black/25`}
      onClick={() => closeMenu()}
    >
      <div
        ref={mobileMenuRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-selector-mobile-title"
        data-testid="model-selector-menu"
        data-mobile="true"
        className="absolute inset-x-0 bottom-0 flex h-[82dvh] flex-col rounded-t-[28px] border border-border bg-background shadow-[0_-18px_48px_rgba(0,0,0,0.18)]"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) =>
          handleMobileModelSelectorDialogKeyDown(
            event,
            mobileMenuRef.current,
            closeMenu,
          )
        }
      >
        <div className="mx-auto mt-3 h-1 w-11 rounded-full bg-border" />
        <div className="flex items-center justify-between px-5 pb-3 pt-4">
          <div className="min-w-0">
            <h2
              id="model-selector-mobile-title"
              className="text-lg font-semibold text-text-primary"
            >
              {t("workbench.model_picker_title")}
            </h2>
            <p className="mt-1 truncate text-xs text-text-muted">
              {buttonLabel}
            </p>
          </div>
          <button
            type="button"
            ref={mobileCloseButtonRef}
            data-testid="model-selector-close-button"
            aria-label={t("workbench.close_menu")}
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
              onChange={(event) => setMobileQuery(event.target.value)}
              placeholder={t("workbench.search_models")}
              className="min-w-0 flex-1 bg-transparent text-base leading-5 text-text-primary outline-none placeholder:text-text-muted"
            />
          </label>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-5">
          <div className="mb-5 shrink-0 space-y-4">
            {controlsAboveFamilies.map(renderMobileControlSection)}
            {!supportsReasoningControl && (
              <ModelAutomaticReasoningOption translate={t} />
            )}
          </div>

          <div className="scrollbar-none -mx-5 mb-5 shrink-0 overflow-x-auto px-5">
            <div className="flex gap-2">
              {familyGroups.map((group) => {
                const active = group.config.id === activeGroup?.config.id;
                return (
                  <button
                    key={group.config.id}
                    type="button"
                    data-testid={`model-family-${group.config.id}`}
                    onClick={() => activateMobileFamily(group.config.id)}
                    className={[
                      "h-11 min-w-[44px] shrink-0 rounded-full px-4 text-sm font-medium",
                      active
                        ? "bg-text-primary text-background"
                        : "bg-surface text-text-secondary",
                    ].join(" ")}
                  >
                    {group.config.label}
                  </button>
                );
              })}
            </div>
          </div>

          <section
            className="flex min-h-0 flex-1 flex-col space-y-2"
            data-testid="model-selector-submenu"
          >
            <h3 className="shrink-0 px-1 text-xs font-semibold text-text-muted">
              {activeGroup?.config.label ?? t("workbench.model_version")}
            </h3>
            {mobileModels.length > 0 ? (
              <div
                data-testid="model-selector-model-list"
                className="scrollbar-none min-h-0 flex-1 space-y-2 overflow-y-auto pb-2"
              >
                {mobileModels.map((model) => {
                  const selected =
                    model.name === selectedModel?.name &&
                    model.type === selectedModel?.type;
                  const modelDisabled = Boolean(model.compatibilityDisabled);
                  const disabledMessage = modelDisabled
                    ? modelCompatibilityDisabledMessage(
                        model.compatibilityDisabledReason,
                        resolveControlLabel,
                      )
                    : undefined;
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
                          onBlockedModelSelect?.(model, disabledMessage);
                          return;
                        }
                        handleSelectModel(model);
                      }}
                      className={[
                        "flex min-h-14 w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left",
                        modelDisabled && "cursor-not-allowed opacity-70",
                        selected
                          ? "border-primary/30 bg-primary/10"
                          : "border-transparent bg-surface",
                      ].join(" ")}
                    >
                      <span className="min-w-0 flex-1">
                        <span
                          className={[
                            "flex items-center gap-1.5 truncate text-sm font-semibold",
                            modelDisabled
                              ? "text-text-muted"
                              : "text-text-primary",
                          ].join(" ")}
                        >
                          <span className="truncate">
                            {getModelDisplayLabel(
                              model,
                              selectedModelOptions,
                              resolveControlLabel,
                            )}
                          </span>
                          {isCloudModel(model) && (
                            <Cloud
                              aria-label={t(
                                "workbench.environment_cloud",
                                "云端",
                              )}
                              className="h-3.5 w-3.5 shrink-0 text-text-muted"
                            />
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-text-muted">
                          {disabledMessage ||
                            model.displayName ||
                            model.modelId ||
                            model.name}
                        </span>
                      </span>
                      {selected && (
                        <Check className="h-5 w-5 shrink-0 text-text-primary" />
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              emptyState
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
            {t("workbench.model_auto_select")}
          </button>
          <button
            type="button"
            data-testid="model-selector-confirm-button"
            onClick={() => closeMenu()}
            className="h-11 flex-1 rounded-full bg-text-primary text-sm font-semibold text-background"
          >
            {t("workbench.use_current_model")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
