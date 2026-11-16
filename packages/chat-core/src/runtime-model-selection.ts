import type { ModelSelectionConfig } from "./runtime-stream-types";
import type { ModelType, UnifiedModel } from "./models";

export function findModelForSelection(
  models: UnifiedModel[],
  selection?: ModelSelectionConfig | null,
): UnifiedModel | null {
  if (!selection?.modelName) {
    return null;
  }

  const candidates = models.filter(
    (model) =>
      model.name === selection.modelName &&
      (!selection.modelType || model.type === selection.modelType),
  );
  const options = selection.options ?? {};
  const codexProviderId = options.codexProviderId;
  const runnerModelProvider = options.runnerModelProvider;
  const modelNamespace = options.weworkCloudModelNamespace;
  const resourceUserId = options.weworkCloudModelResourceUserId;
  const hasIdentity = Boolean(
    codexProviderId || runnerModelProvider || modelNamespace || resourceUserId,
  );
  if (!hasIdentity) {
    return candidates[0] ?? null;
  }

  return (
    candidates.find((model) => {
      const configuredProviderId = stringConfigValue(
        model.config,
        "codexProviderId",
      );
      return (
        (!codexProviderId || configuredProviderId === codexProviderId) &&
        (!runnerModelProvider ||
          (configuredProviderId ?? model.runtime?.provider) ===
            runnerModelProvider) &&
        (!modelNamespace || model.namespace === modelNamespace) &&
        (!resourceUserId ||
          String(model.resourceUserId ?? "") === resourceUserId)
      );
    }) ?? null
  );
}

export function modelSelectionFromRuntimeHandle(
  runtimeHandle?: Record<string, unknown> | null,
): (ModelSelectionConfig & { options: Record<string, string> }) | null {
  const selection = recordValue(
    runtimeHandle?.modelSelection ?? runtimeHandle?.model_selection,
  );
  const modelName =
    stringValue(selection.modelName) ?? stringValue(selection.model_name);
  if (!modelName) {
    return null;
  }

  const modelType =
    modelTypeValue(selection.modelType) ?? modelTypeValue(selection.model_type);
  const options = recordValue(selection.options);

  return {
    modelName,
    modelType: modelType || null,
    options: Object.fromEntries(
      Object.entries(options)
        .map(([key, optionValue]) => [key, stringValue(optionValue)])
        .filter((entry): entry is [string, string] => Boolean(entry[1])),
    ),
  };
}

export function modelFromTaskSnapshot(
  selection?: ModelSelectionConfig | null,
): UnifiedModel | null {
  if (!selection?.modelName || !selection.modelType) return null;

  const resourceUserIdValue = selection.options?.weworkCloudModelResourceUserId;
  const resourceUserId = resourceUserIdValue
    ? Number(resourceUserIdValue)
    : null;
  const providerId =
    selection.options?.codexProviderId ??
    selection.options?.runnerModelProvider;
  return {
    name: selection.modelName,
    displayName: selection.modelName,
    modelId: selection.modelName,
    type: selection.modelType,
    provider: selection.modelType === "runtime" ? "local" : "cloud",
    ...(selection.modelType === "runtime" && providerId
      ? {
          config: { codexProviderId: providerId },
          runtime: { family: "codex", provider: providerId },
        }
      : {}),
    ...(selection.options?.weworkCloudModelNamespace
      ? { namespace: selection.options.weworkCloudModelNamespace }
      : {}),
    ...(resourceUserId !== null && Number.isSafeInteger(resourceUserId)
      ? { resourceUserId }
      : {}),
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringConfigValue(
  config: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  return stringValue(config?.[key]);
}

function modelTypeValue(value: unknown): ModelType | null {
  if (
    value === "public" ||
    value === "user" ||
    value === "group" ||
    value === "runtime"
  ) {
    return value;
  }
  return null;
}
