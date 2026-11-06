// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOptions, UnifiedModel } from "@wegent/chat-core/models";
import { createCollaborationTranslator } from "../i18n";
import { ModelSelector } from "./ModelSelector";
import { getControlsForModel, normalizeModelOptions } from "./model-ui";
import { selectedModelExecutionFields } from "./runtimeModelSelection";

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

function modelNamed(name: string, reasoningEfforts = efforts): UnifiedModel {
  return {
    ...model(reasoningEfforts),
    name,
    modelId: name,
    displayName: name,
  };
}

function element(id: string) {
  const target = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!target) throw new Error(`Missing control ${id}`);
  return target;
}

function FixedModelHarness({
  models,
  initialModel,
  initialOptions,
}: {
  models: UnifiedModel[];
  initialModel: UnifiedModel;
  initialOptions: ModelOptions;
}) {
  const [currentModel, setCurrentModel] = useState(initialModel);
  const [selection, setSelection] = useState(initialOptions);
  const [generation, setGeneration] = useState(0);
  return (
    <>
      <button
        data-testid="remount"
        onClick={() => setGeneration((value) => value + 1)}
      >
        Remount
      </button>
      <output data-testid="selection-state">
        {JSON.stringify({
          modelName: currentModel?.name,
          options: selection,
        })}
      </output>
      <ModelSelector
        key={generation}
        translate={createCollaborationTranslator("en")}
        isMobile={false}
        models={models}
        selectedModel={currentModel}
        selectedModelOptions={selection}
        disabled={false}
        onSelectModel={setCurrentModel}
        onSelectModelAndOptions={(model, options) => {
          setCurrentModel(model);
          setSelection(options);
        }}
        onSelectModelOption={(key, value) =>
          setSelection((current) => ({ ...current, [key]: value }))
        }
        onOpenModelSettings={vi.fn()}
      />
    </>
  );
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

  it.each([
    ["the same model", "gpt-6.1-sol"],
    ["another model in the same family", "gpt-6.1-sol-luna"],
  ])(
    "normalizes a Catalog-disabled preset effort when switching to %s as a fixed model",
    (_, targetName) => {
      const presetModel = modelNamed("gpt-6.1-sol", ["high"]);
      const siblingModel = modelNamed("gpt-6.1-sol-luna", ["high"]);
      const models = [presetModel, siblingModel];
      const presetKey = "runtime:gpt-6.1-sol:recommended";
      presetModel.config!.ui = {
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
                { modelName: presetModel.name, reasoningEffort: "ultra" },
                { modelName: siblingModel.name, reasoningEffort: "ultra" },
              ],
            },
          ],
        },
      };
      const targetModel = models.find((model) => model.name === targetName)!;

      act(() =>
        root.render(
          <FixedModelHarness
            models={models}
            initialModel={presetModel}
            initialOptions={{
              reasoning: "ultra",
              modelSelection: presetKey,
            }}
          />,
        ),
      );
      act(() => element("model-selector-button").click());
      expect(element("model-simple-header").textContent).toContain("Ultra");
      act(() => element("model-advanced-toggle").click());
      act(() => element(`model-option-${targetModel.name}`).click());

      const selection = JSON.parse(
        element("selection-state").textContent ?? "{}",
      ) as { modelName: string; options: ModelOptions };
      expect(selection).toEqual({
        modelName: targetModel.name,
        options: {
          reasoning: "high",
          modelSelection: "model",
        },
      });
      expect(element("model-selector-button").textContent).toContain("High");
      expect(element("model-selector-button").textContent).not.toContain(
        "Ultra",
      );

      act(() => element("remount").click());
      expect(element("model-selector-button").textContent).toContain("High");
      expect(
        selectedModelExecutionFields(targetModel, selection.options)
          .modelOptions.reasoning,
      ).toBe("high");
    },
  );
});
