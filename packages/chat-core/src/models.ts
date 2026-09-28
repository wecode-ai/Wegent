export type ModelType = "public" | "user" | "group" | "runtime";

export type ModelOptions = Record<string, string>;

export type ModelCompatibilityDisabledReason =
  | "missing_current_runtime_family"
  | "missing_target_runtime_family"
  | "unavailable"
  | "runtime_family_mismatch";

export interface ModelRuntime {
  family?: string | null;
  provider?: string | null;
}

export interface ModelCapabilities {
  supportsImage?: boolean;
  supportsVideo?: boolean;
}

export interface UnifiedModel {
  name: string;
  type: ModelType;
  displayName?: string | null;
  provider?: string | null;
  modelId?: string | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  modelCapabilities?: ModelCapabilities | null;
  namespace?: string;
  resourceUserId?: number;
  config?: Record<string, unknown>;
  runtime?: ModelRuntime | null;
  isActive?: boolean;
  compatibilityDisabled?: boolean;
  compatibilityDisabledReason?: ModelCompatibilityDisabledReason;
}
