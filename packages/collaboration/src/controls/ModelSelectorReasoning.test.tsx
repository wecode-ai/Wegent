// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOptions, UnifiedModel } from "@wegent/chat-core/models";
import { createCollaborationTranslator } from "../i18n";
import { ModelSelector } from "./ModelSelector";
import { getControlsForModel, normalizeModelOptions } from "./model-ui";

let root: Root;
let container: HTMLDivElement;
const efforts = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

function model(reasoningEfforts = efforts): UnifiedModel {
  return {
    name: "gpt-6.1-sol",
    modelId: "gpt-6.1-sol",
    displayName: "GPT-6.1 Sol",
    type: "runtime",
    provider: "local",
    config: {
      weworkModelKind: "codex-official",
      ui: {
        family: "codex-official",
        reasoningEfforts,
        defaultReasoningEffort: "high",
      },
    },
  };
}

function element(id: string) {
  const target = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!target) throw new Error(`Missing control ${id}`);
  return target;
}

function renderSelector(
  selectedModel: UnifiedModel,
  locale: "zh-CN" | "en",
  options: ModelOptions,
) {
  function Harness() {
    const [selection, setSelection] = useState(options);
    const [generation, setGeneration] = useState(0);
    return (
      <>
        <button
          data-testid="remount"
          onClick={() => setGeneration((value) => value + 1)}
        >
          Remount
        </button>
        <ModelSelector
          key={generation}
          translate={createCollaborationTranslator(locale)}
          isMobile={false}
          models={[selectedModel]}
          selectedModel={selectedModel}
          selectedModelOptions={selection}
          disabled={false}
          onSelectModel={vi.fn()}
          onSelectModelAndOptions={(_, next) =>
            setSelection(normalizeModelOptions(selectedModel, next))
          }
          onSelectModelOption={(key, value) =>
            setSelection((current) =>
              normalizeModelOptions(selectedModel, {
                ...current,
                [key]: value,
              }),
            )
          }
          onOpenModelSettings={vi.fn()}
        />
      </>
    );
  }
  act(() => root.render(<Harness />));
  act(() => element("model-selector-button").click());
}

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

describe("Catalog reasoning and independent recommended presets", () => {
  it("shows every enabled fixed-model effort, including max", () => {
    renderSelector(model(), "en", {
      reasoning: "high",
      modelSelection: "model",
    });
    for (const effort of efforts)
      expect(element(`model-control-reasoning-${effort}`)).toBeTruthy();
    act(() => element("model-control-reasoning-max").click());
    expect(element("model-simple-header").textContent).toContain("Maximum");
    expect(
      document.querySelector('[data-testid="reasoning-ultra-burst"]'),
    ).toBeNull();
  });

  it.each(["zh-CN", "en"] as const)(
    "distinguishes Ultra and retains its effect in %s",
    (locale) => {
      renderSelector(model(), locale, {
        reasoning: "ultra",
        modelSelection: "model",
      });
      expect(element("model-simple-header").textContent).toContain("Ultra");
      expect(
        element("model-control-reasoning-track").getAttribute("aria-valuetext"),
      ).toBe("Ultra");
      expect(element("reasoning-ultra-burst")).toBeTruthy();
      act(() => element("model-control-reasoning-xhigh").click());
      expect(element("model-simple-header").textContent).toContain(
        locale === "en" ? "Extra High" : "极高",
      );
      expect(
        document.querySelector('[data-testid="reasoning-ultra-burst"]'),
      ).toBeNull();
    },
  );

  it("hides disabled fixed-model efforts and respects an empty catalog", () => {
    const selected = model(["low", "high"]);
    renderSelector(selected, "en", {
      reasoning: "high",
      modelSelection: "model",
    });
    expect(
      document.querySelector('[data-testid="model-control-reasoning-max"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="model-control-reasoning-ultra"]'),
    ).toBeNull();
    expect(
      getControlsForModel(model([])).find(
        (control) => control.id === "reasoning",
      ),
    ).toBeUndefined();
  });

  it("keeps recommended efforts selectable and restorable when disabled in Catalog", () => {
    const selected = model(["high"]);
    selected.config!.ui = {
      family: "codex-official",
      reasoningEfforts: ["high"],
      defaultReasoningEffort: "high",
      defaultModel: true,
      sliderModelsConfig: {
        defaultPreset: "recommended",
        presets: [
          {
            name: "recommended",
            models: [
              {
                model: selected.name,
                reasoningEfforts: ["low", "xhigh", "ultra"],
              },
            ],
          },
        ],
      },
    };
    renderSelector(selected, "en", {
      reasoning: "low",
      modelSelection: "runtime:gpt-6.1-sol:recommended",
    });
    for (const effort of ["low", "xhigh", "ultra"])
      expect(element(`model-power-setting-gpt-6-1-sol-${effort}`)).toBeTruthy();
    act(() => element("model-power-setting-gpt-6-1-sol-ultra").click());
    expect(element("model-simple-header").textContent).toContain("Ultra");
    expect(element("reasoning-ultra-burst")).toBeTruthy();
    act(() => element("remount").click());
    expect(element("model-selector-button").textContent).toContain("Ultra");
    act(() => element("model-selector-button").click());
    expect(element("model-selection-mode").textContent).toBe(
      "Recommended model set",
    );
    expect(
      element("model-control-reasoning-track").getAttribute("aria-valuetext"),
    ).toContain("Ultra");
    expect(
      normalizeModelOptions(selected, {
        reasoning: "ultra",
        modelSelection: "model",
      }).reasoning,
    ).toBe("high");
  });
});
