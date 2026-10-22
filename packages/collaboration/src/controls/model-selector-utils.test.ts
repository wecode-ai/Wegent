import { describe, expect, it } from "vitest";
import type { UnifiedModel } from "@wegent/chat-core/models";
import {
  getModelPowerPresets,
  isSelectedPowerSetting,
  modelPowerOptions,
} from "./model-selector-utils";

describe("configured model power presets", () => {
  it("keeps model-only steps and validates explicitly requested efforts", () => {
    const glm: UnifiedModel = {
      name: "cloud-glm",
      type: "public",
      config: { ui: { family: "glm" } },
    };
    const gpt: UnifiedModel = {
      name: "cloud-gpt",
      type: "public",
      config: {
        ui: {
          reasoningEfforts: ["high"],
          sliderModelsConfig: {
            presets: [
              {
                name: "mixed",
                models: [
                  { modelName: glm.name },
                  { modelName: "cloud-gpt", reasoningEffort: "high" },
                  { modelName: "cloud-gpt" },
                  { modelName: glm.name, reasoningEffort: "medium" },
                  { modelName: "cloud-gpt", reasoningEffort: "medium" },
                  { modelName: "cloud-gpt", reasoningEfforts: [] },
                  { modelName: "missing" },
                ],
              },
            ],
          },
        },
      },
    };
    const presets = getModelPowerPresets([glm, gpt]);
    expect(presets).toHaveLength(1);
    const settings = presets[0].settings;
    expect(settings.map(({ id }) => id)).toEqual([
      "cloud-glm",
      "cloud-gpt:high",
      "cloud-gpt",
    ]);
    expect(isSelectedPowerSetting(settings[0], glm)).toBe(true);
    expect(isSelectedPowerSetting(settings[2], gpt, "high")).toBe(true);
    expect(isSelectedPowerSetting(settings[1], gpt, "medium")).toBe(false);
    expect(
      modelPowerOptions(settings[0], { reasoning: "high", speed: "standard" }),
    ).toEqual({ speed: "standard" });
    expect(modelPowerOptions(settings[1])).toEqual({ reasoning: "high" });
  });
});
