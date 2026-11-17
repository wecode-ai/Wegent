import { describe, expect, it } from "vitest";
import {
  findModelForSelection,
  modelFromTaskSnapshot,
} from "./runtime-model-selection";
import type { UnifiedModel } from "./models";

describe("runtime task model identity", () => {
  it("matches desktop Codex providers independently of the local transport", () => {
    const model = (provider: string): UnifiedModel => ({
      name: "gpt",
      type: "runtime",
      provider: "local",
      config: { codexProviderId: provider },
      runtime: { family: "openai.openai-responses", provider: "local" },
    });
    const models = [model("other-account"), model("pc-account")];
    const selection = {
      modelName: "gpt",
      modelType: "runtime" as const,
      options: { runnerModelProvider: "pc-account" },
    };
    expect(findModelForSelection(models, selection)).toBe(models[1]);
    expect(findModelForSelection(models.slice(0, 1), selection)).toBeNull();
  });

  it("distinguishes same-name native models with the saved runner provider", () => {
    const model = (provider: string): UnifiedModel => ({
      name: "gpt",
      type: "runtime",
      provider: "local",
      runtime: { family: "codex", provider },
    });
    const models = [model("other-account"), model("pc-account")];
    const selection = {
      modelName: "gpt",
      modelType: "runtime" as const,
      options: { runnerModelProvider: "pc-account" },
    };
    expect(findModelForSelection(models, selection)).toBe(models[1]);
    expect(findModelForSelection(models.slice(0, 1), selection)).toBeNull();
    expect(modelFromTaskSnapshot(selection)?.runtime?.provider).toBe(
      "pc-account",
    );
  });

  it("retains cloud ownership in snapshots when catalog data is unavailable", () => {
    const model = modelFromTaskSnapshot({
      modelName: "private-gpt",
      modelType: "user",
      options: {
        weworkCloudModelNamespace: "project",
        weworkCloudModelResourceUserId: "7",
      },
    });
    expect(model).toMatchObject({
      name: "private-gpt",
      type: "user",
      namespace: "project",
      resourceUserId: 7,
    });
    expect(modelFromTaskSnapshot({ modelName: "unknown" })).toBeNull();
  });
});
