// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollaborationTranslator } from "../i18n";
import { ModelPowerSlider } from "./ModelPowerSlider";
import type { UnifiedModel } from "@wegent/chat-core/models";

let container: HTMLDivElement;
let root: Root;

const translate = createCollaborationTranslator("zh-CN");
const currentModel: UnifiedModel = {
  name: "current",
  type: "runtime",
  displayName: "Current",
  config: {
    ui: {
      family: "codex-official",
      reasoningEfforts: ["low", "high"],
    },
  },
};
const nextModel: UnifiedModel = {
  name: "next",
  type: "runtime",
  displayName: "Next",
  config: {
    ui: {
      family: "codex-official",
      reasoningEfforts: ["low", "high"],
    },
  },
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

describe("ModelPowerSlider", () => {
  it("prefers an exact effort step and clears its override when choosing the same model without an effort", () => {
    const onSelectModelAndOptions = vi.fn();
    const onSelectModelOption = vi.fn();
    act(() =>
      root.render(
        <ModelPowerSlider
          translate={translate}
          powerSettings={[
            { id: "current", model: currentModel },
            {
              id: "current:high",
              model: currentModel,
              reasoningEffort: "high",
            },
          ]}
          selectedModel={currentModel}
          selectedModelOptions={{ reasoning: "high", speed: "standard" }}
          onSelectModel={vi.fn()}
          onSelectModelAndOptions={onSelectModelAndOptions}
          onSelectModelOption={onSelectModelOption}
        />,
      ),
    );
    const step = container.querySelector<HTMLElement>(
      '[data-testid="model-power-setting-current"]',
    )!;
    const exactStep = container.querySelector<HTMLElement>(
      '[data-testid="model-power-setting-current-high"]',
    )!;
    const track = container.querySelector<HTMLElement>(
      '[data-testid="model-control-reasoning-track"]',
    )!;
    expect(track.getAttribute("aria-valuetext")).toBe(
      exactStep.getAttribute("aria-label"),
    );
    act(() => step.click());
    expect(onSelectModelAndOptions).toHaveBeenCalledWith(currentModel, {
      speed: "standard",
    });
    expect(onSelectModelOption).not.toHaveBeenCalled();
  });

  it("removes the previous reasoning override when selecting a model-only step", () => {
    const modelOnly: UnifiedModel = {
      name: "model-only",
      type: "public",
      displayName: "Model only",
      config: { ui: { family: "glm" } },
    };
    const onSelectModelAndOptions = vi.fn();
    const onSelectModelOption = vi.fn();
    act(() =>
      root.render(
        <ModelPowerSlider
          translate={translate}
          powerSettings={[
            {
              id: "current:high",
              model: currentModel,
              reasoningEffort: "high",
            },
            { id: "model-only", model: modelOnly },
          ]}
          selectedModel={currentModel}
          selectedModelOptions={{ reasoning: "high", speed: "standard" }}
          onSelectModel={vi.fn()}
          onSelectModelAndOptions={onSelectModelAndOptions}
          onSelectModelOption={onSelectModelOption}
        />,
      ),
    );
    const step = container.querySelector<HTMLElement>(
      '[data-testid="model-power-setting-model-only"]',
    );
    expect(step?.getAttribute("aria-label")).toBe("Model only");
    act(() => step!.click());
    expect(onSelectModelAndOptions).toHaveBeenCalledWith(modelOnly, {
      speed: "standard",
    });
    expect(onSelectModelOption).not.toHaveBeenCalled();
  });

  it("does not apply reasoning when the host rejects a model change", () => {
    const onSelectModel = vi.fn(() => false);
    const onSelectModelOption = vi.fn();

    act(() =>
      root.render(
        <ModelPowerSlider
          translate={translate}
          powerSettings={[
            {
              id: "current:low",
              model: currentModel,
              reasoningEffort: "low",
            },
            {
              id: "next:high",
              model: nextModel,
              reasoningEffort: "high",
            },
          ]}
          selectedModel={currentModel}
          selectedModelOptions={{ reasoning: "low" }}
          onSelectModel={onSelectModel}
          onSelectModelOption={onSelectModelOption}
        />,
      ),
    );

    act(() => {
      document
        .querySelector<HTMLElement>(
          '[data-testid="model-power-setting-next-high"]',
        )
        ?.click();
    });

    expect(onSelectModel).toHaveBeenCalledWith(nextModel);
    expect(onSelectModelOption).not.toHaveBeenCalled();
  });
});
