// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollaborationTranslator } from "../i18n";
import { CollaborationTheme } from "../theme";
import { ModelSelector } from "./ModelSelector";
import { PermissionModeSelector } from "./PermissionModeSelector";
import { codexRuntimeModels } from "@wegent/chat-core/runtime-model-catalog";
import type { CodexOfficialModel } from "@wegent/chat-core/codex-official-models";
import type { UnifiedModel } from "@wegent/chat-core/models";

let container: HTMLDivElement;
let root: Root;
const translate = createCollaborationTranslator("zh-CN");

const cloudDeepseekModel: UnifiedModel = {
  name: "deepseek-flash-responses(公网)",
  type: "public",
  displayName: "公网:DeepSeek-V4-Flash",
  modelId: "deepseek-flash",
  config: { protocol: "openai-responses" },
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function element(id: string) {
  const target = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!target) throw new Error(`Missing control ${id}`);
  return target;
}

function officialModel(modelId: string, isDefault = false): CodexOfficialModel {
  return {
    id: modelId,
    displayName: modelId,
    modelId,
    providerId: "openai",
    providerName: "OpenAI",
    providerType: "official",
    providerCurrent: true,
    description: null,
    hidden: false,
    isDefault,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    supportsFastMode: true,
  };
}

describe("model controls without a desktop host", () => {
  it.each([false, true])(
    "selects the preset owner without an explicit effort even when it is second (atomic=%s)",
    (atomic) => {
      const firstModel: UnifiedModel = {
        name: "cloud-first-deepseek",
        type: "public",
        config: { ui: { family: "deepseek" } },
      };
      const defaultModel: UnifiedModel = {
        ...cloudDeepseekModel,
        config: {
          ...cloudDeepseekModel.config,
          ui: {
            defaultModel: true,
            sliderModelsConfig: {
              defaultPreset: "recommended",
              presets: [
                {
                  name: "recommended",
                  models: [
                    { modelName: firstModel.name },
                    { modelName: cloudDeepseekModel.name },
                  ],
                },
              ],
            },
          },
        },
      };
      const onSelectModel = vi.fn();
      const onSelectModelOption = vi.fn();
      const onSelectModelAndOptions = vi.fn();
      act(() =>
        root.render(
          <ModelSelector
            translate={translate}
            isMobile={false}
            models={[firstModel, defaultModel]}
            selectedModel={firstModel}
            selectedModelOptions={{ reasoning: "high" }}
            disabled={false}
            onSelectModel={onSelectModel}
            onSelectModelOption={onSelectModelOption}
            onSelectModelAndOptions={
              atomic ? onSelectModelAndOptions : undefined
            }
            onOpenModelSettings={vi.fn()}
          />,
        ),
      );
      act(() => element("model-selector-button").click());
      act(() => element("model-advanced-toggle").click());
      act(() => element("model-option-default").click());
      if (atomic) {
        expect(onSelectModelAndOptions).toHaveBeenCalledWith(defaultModel, {});
      } else {
        expect(onSelectModel).toHaveBeenCalledWith(defaultModel);
      }
      expect(onSelectModelOption).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "selects model-only preset steps without reasoning (atomic=%s)",
    (atomic) => {
      const glm: UnifiedModel = {
        name: "cloud-glm",
        type: "public",
        config: {
          ui: {
            family: "glm",
            defaultModel: true,
            sliderModelsConfig: {
              defaultPreset: "recommended",
              presets: [
                {
                  name: "recommended",
                  models: [
                    { modelName: "cloud-glm" },
                    { modelName: "cloud-deepseek" },
                  ],
                },
              ],
            },
          },
        },
      };
      const deepseek: UnifiedModel = {
        name: "cloud-deepseek",
        type: "public",
        config: { ui: { family: "deepseek" } },
      };
      const onSelectModel = vi.fn();
      const onSelectModelOption = vi.fn();
      const onSelectModelAndOptions = vi.fn();
      act(() =>
        root.render(
          <ModelSelector
            translate={translate}
            isMobile={false}
            models={[glm, deepseek]}
            selectedModel={glm}
            selectedModelOptions={{}}
            disabled={false}
            onSelectModel={onSelectModel}
            onSelectModelOption={onSelectModelOption}
            onSelectModelAndOptions={
              atomic ? onSelectModelAndOptions : undefined
            }
            onOpenModelSettings={vi.fn()}
          />,
        ),
      );
      act(() => element("model-selector-button").click());
      expect(
        element("model-power-setting-cloud-glm").getAttribute("aria-label"),
      ).not.toContain("undefined");
      expect(element("model-power-setting-cloud-deepseek")).toBeTruthy();
      act(() => element("model-power-setting-cloud-deepseek").click());
      if (atomic) {
        expect(onSelectModelAndOptions).toHaveBeenCalledWith(deepseek, {});
      } else {
        expect(onSelectModel).toHaveBeenCalledWith(deepseek);
      }
      expect(onSelectModelOption).not.toHaveBeenCalled();

      act(() => element("model-advanced-toggle").click());
      expect(element("model-option-default").parentElement).toBe(
        element("model-source-cloud"),
      );
      act(() => element("model-option-default").click());
      if (atomic) {
        expect(onSelectModelAndOptions).toHaveBeenLastCalledWith(glm, {});
      } else {
        expect(onSelectModel).toHaveBeenLastCalledWith(glm);
      }
      expect(onSelectModelOption).not.toHaveBeenCalled();
    },
  );

  it("renders cloud presets before family groups and keeps local presets in their source", () => {
    const cloudModel: UnifiedModel = {
      ...cloudDeepseekModel,
      config: {
        ui: {
          defaultModel: true,
          reasoningEfforts: ["medium"],
          sliderModelsConfig: {
            defaultPreset: "recommended",
            presets: [
              {
                name: "recommended",
                label: "推荐",
                models: [
                  {
                    modelName: cloudDeepseekModel.name,
                    reasoningEffort: "medium",
                  },
                ],
              },
              {
                name: "quality",
                label: "高质量",
                models: [{ modelName: "cloud-gpt", reasoningEffort: "high" }],
              },
            ],
          },
        },
      },
    };
    const gptModel: UnifiedModel = {
      name: "cloud-gpt",
      type: "public",
      config: { ui: { family: "gpt", reasoningEfforts: ["high"] } },
    };
    const localModels = codexRuntimeModels(
      [officialModel("gpt-6.1-sol", true)],
      null,
      true,
    );
    const onSelectModelAndOptions = vi.fn();

    act(() =>
      root.render(
        <ModelSelector
          translate={translate}
          isMobile={false}
          models={[cloudModel, gptModel, ...localModels]}
          selectedModel={cloudModel}
          selectedModelOptions={{ reasoning: "medium" }}
          disabled={false}
          onSelectModel={vi.fn()}
          onSelectModelOption={vi.fn()}
          onSelectModelAndOptions={onSelectModelAndOptions}
          onOpenModelSettings={vi.fn()}
        />,
      ),
    );
    act(() => element("model-selector-button").click());

    const cloudSource = element("model-source-cloud");
    const cloudPresets = cloudSource.querySelectorAll("[data-model-preset]");
    expect(cloudPresets).toHaveLength(2);
    for (const preset of cloudPresets) {
      expect(preset.parentElement).toBe(cloudSource);
      expect(
        preset.compareDocumentPosition(
          element(`model-option-${cloudModel.name}`),
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    expect(element(`model-option-${cloudModel.name}`).parentElement).toBe(
      element("model-group-deepseek"),
    );
    expect(element("model-option-cloud-gpt").parentElement).toBe(
      element("model-group-gpt"),
    );
    const localSource = element("model-source-local-chatgpt");
    const localPresets = localSource.querySelectorAll("[data-model-preset]");
    expect(localPresets).toHaveLength(1);
    expect(localPresets[0].parentElement).toBe(localSource);

    act(() => element("model-option-preset-quality").click());
    expect(onSelectModelAndOptions).toHaveBeenCalledWith(gptModel, {
      reasoning: "high",
    });
  });

  it.each([false, true])(
    "keeps the scoped theme in the model portal (mobile=%s)",
    (mobile) => {
      const openSettings = vi.fn();
      act(() =>
        root.render(
          <CollaborationTheme mode="dark">
            <ModelSelector
              translate={translate}
              isMobile={mobile}
              models={[]}
              selectedModel={null}
              selectedModelOptions={{}}
              disabled={false}
              onSelectModel={vi.fn()}
              onSelectModelOption={vi.fn()}
              onOpenModelSettings={openSettings}
              onOpenCloudConnections={vi.fn()}
            />
          </CollaborationTheme>,
        ),
      );
      act(() => element("model-selector-button").click());
      const menu = element("model-selector-menu");
      const surface = menu.closest<HTMLElement>(".collaboration-theme")!;
      expect(surface).not.toBeNull();
      expect(container.contains(surface)).toBe(false);
      expect(surface.dataset.theme).toBe("dark");
      expect(surface.style.getPropertyValue("--color-bg-base")).toBe(
        "24 24 24",
      );
      expect(surface.style.display).not.toBe("contents");
      expect(menu.textContent).not.toContain("workbench.");
      act(() => element("model-selector-add-custom-model").click());
      expect(openSettings).toHaveBeenCalledOnce();
      expect(
        document.querySelector('[data-testid="model-selector-menu"]'),
      ).toBeNull();
    },
  );

  it("preserves the theme and deliberate permission confirmation across both portals", () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <CollaborationTheme mode="dark">
          <PermissionModeSelector
            translate={translate}
            value="read-only"
            onChange={onChange}
          />
        </CollaborationTheme>,
      ),
    );
    act(() => element("permission-mode-menu-button").click());
    expect(
      element("permission-mode-menu-button-menu").style.getPropertyValue(
        "--color-bg-base",
      ),
    ).toBe("24 24 24");
    act(() => element("permission-mode-full-access").click());
    expect(onChange).not.toHaveBeenCalled();
    expect(element("full-access-confirm-overlay").dataset.theme).toBe("dark");
    act(() => element("full-access-confirm-submit").click());
    expect(onChange).toHaveBeenCalledWith("full-access");
  });

  it("does not apply preset options when the host rejects the model selection", () => {
    const models = codexRuntimeModels(
      [
        officialModel("gpt-6-luna"),
        officialModel("gpt-6.1-sol", true),
        officialModel("gpt-6-astra"),
      ],
      null,
      true,
    );
    const selectedModel = models.find(
      (model) => model.modelId === "gpt-6.1-sol",
    )!;
    const onSelectModel = vi.fn(() => false);
    const onSelectModelOption = vi.fn();

    act(() =>
      root.render(
        <CollaborationTheme mode="dark">
          <ModelSelector
            translate={translate}
            isMobile={false}
            models={models}
            selectedModel={selectedModel}
            selectedModelOptions={{ reasoning: "high", speed: "fast" }}
            disabled={false}
            onSelectModel={onSelectModel}
            onSelectModelOption={onSelectModelOption}
            onOpenModelSettings={vi.fn()}
          />
        </CollaborationTheme>,
      ),
    );

    act(() => element("model-selector-button").click());
    expect(
      element("model-advanced-fast-mode-toggle").getAttribute("aria-label"),
    ).toBe(translate("workbench.speed_fast", "快速"));
    act(() => element("model-reset-default-button").click());

    expect(onSelectModel).toHaveBeenCalledOnce();
    expect(onSelectModelOption).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="model-selector-menu"]'),
    ).toBeNull();
  });

  it("keeps default mode when the host rejects a direct model selection", () => {
    const models = codexRuntimeModels(
      [
        officialModel("gpt-6-luna"),
        officialModel("gpt-6.1-sol", true),
        officialModel("gpt-6-astra"),
      ],
      null,
      true,
    );
    const selectedModel = models.find(
      (model) => model.modelId === "gpt-6.1-sol",
    )!;
    const alternateModel = models.find(
      (model) => model.modelId === "gpt-6-astra",
    )!;
    const onSelectModel = vi.fn(() => false);

    act(() =>
      root.render(
        <CollaborationTheme mode="dark">
          <ModelSelector
            translate={translate}
            isMobile={false}
            models={models}
            selectedModel={selectedModel}
            selectedModelOptions={{ reasoning: "medium", speed: "standard" }}
            disabled={false}
            onSelectModel={onSelectModel}
            onSelectModelOption={vi.fn()}
            onOpenModelSettings={vi.fn()}
          />
        </CollaborationTheme>,
      ),
    );

    act(() => element("model-selector-button").click());
    expect(
      document.querySelector('[data-testid="model-reset-default-button"]'),
    ).toBeNull();
    act(() => element("model-advanced-toggle").click());
    act(() => element(`model-option-${alternateModel.name}`).click());

    expect(onSelectModel).toHaveBeenCalledWith(alternateModel);
    expect(
      document.querySelector('[data-testid="model-selector-menu"]'),
    ).toBeNull();

    act(() => element("model-selector-button").click());
    expect(
      document.querySelector('[data-testid="model-reset-default-button"]'),
    ).toBeNull();
  });

  it.each(["deepseek", "gpt", "model-interface"])(
    "exposes catalog reasoning levels for a cloud model in the %s family",
    (family) => {
      const model = {
        ...cloudDeepseekModel,
        config: { ...cloudDeepseekModel.config, ui: { family } },
      };
      const onSelectModelOption = vi.fn();
      act(() =>
        root.render(
          <CollaborationTheme mode="dark">
            <ModelSelector
              translate={translate}
              isMobile
              models={[model]}
              selectedModel={model}
              selectedModelOptions={{ reasoning: "high" }}
              disabled={false}
              onSelectModel={vi.fn()}
              onSelectModelOption={onSelectModelOption}
              onOpenModelSettings={vi.fn()}
              onOpenCloudConnections={vi.fn()}
            />
          </CollaborationTheme>,
        ),
      );

      act(() => element("model-selector-button").click());
      // element() throws when a control is missing.
      const optionLabels = ["low", "high", "max"].map((value) =>
        element(`model-control-reasoning-${value}`).textContent?.trim(),
      );
      expect(optionLabels.every(Boolean)).toBe(true);
      expect(
        document.querySelector(
          '[data-testid="model-control-reasoning-medium"]',
        ),
      ).toBeNull();
      expect(
        document.querySelector('[data-testid="model-control-reasoning-xhigh"]'),
      ).toBeNull();
      act(() => element("model-control-reasoning-max").click());

      expect(onSelectModelOption).toHaveBeenCalledWith("reasoning", "max");
    },
  );

  it.each(["deepseek", "gpt", "model-interface"])(
    "enables the reasoning slider for a cloud catalog model in the %s family on desktop",
    (family) => {
      const model = {
        ...cloudDeepseekModel,
        config: { ...cloudDeepseekModel.config, ui: { family } },
      };
      const onSelectModelOption = vi.fn();
      act(() =>
        root.render(
          <CollaborationTheme mode="dark">
            <ModelSelector
              translate={translate}
              isMobile={false}
              models={[model]}
              selectedModel={model}
              selectedModelOptions={{ reasoning: "high" }}
              disabled={false}
              onSelectModel={vi.fn()}
              onSelectModelOption={onSelectModelOption}
              onOpenModelSettings={vi.fn()}
              onOpenCloudConnections={vi.fn()}
            />
          </CollaborationTheme>,
        ),
      );

      act(() => element("model-selector-button").click());

      const reasoningSlider = element("model-control-reasoning-track");
      expect(reasoningSlider.getAttribute("aria-valuetext")).toBe(
        translate("workbench.local_model_reasoning_high", "High"),
      );
      act(() => element("model-control-reasoning-max").click());
      expect(onSelectModelOption).toHaveBeenCalledWith("reasoning", "max");
    },
  );
});
