// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollaborationTranslator } from "../i18n";
import { ModelPowerSlider } from "./ModelPowerSlider";
import type { ModelControlConfig } from "./model-ui";
import type { UnifiedModel } from "@wegent/chat-core/models";

let container: HTMLDivElement;
let root: Root;

const translate = createCollaborationTranslator("zh-CN");
const reasoningControl: ModelControlConfig = {
  id: "reasoning",
  label: "Reasoning",
  defaultValue: "low",
  options: [
    { value: "low", label: "Low", order: 0 },
    { value: "high", label: "High", order: 1 },
  ],
};
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
  it("does not apply reasoning when the host rejects a model change", () => {
    const onSelectModel = vi.fn(() => false);
    const onSelectModelOption = vi.fn();

    act(() =>
      root.render(
        <ModelPowerSlider
          translate={translate}
          control={reasoningControl}
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
