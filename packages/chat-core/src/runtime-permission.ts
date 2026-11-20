export const RUNTIME_PERMISSION_MODE_OPTION = "permissionMode";

export type RuntimePermissionMode =
  | "read-only"
  | "workspace-write"
  | "full-access";

export const DEFAULT_RUNTIME_PERMISSION_MODE: RuntimePermissionMode =
  "full-access";

export function runtimePermissionMode(
  options?: Record<string, string>,
): RuntimePermissionMode {
  const value = options?.[RUNTIME_PERMISSION_MODE_OPTION];
  if (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "full-access"
  )
    return value;
  return DEFAULT_RUNTIME_PERMISSION_MODE;
}

export function runtimePermissionProfile(mode: RuntimePermissionMode): string {
  switch (mode) {
    case "read-only":
      return ":read-only";
    case "workspace-write":
      return ":workspace";
    case "full-access":
      return ":danger-full-access";
  }
}

export const RUNTIME_COMMAND_APPROVAL_OPTION = "commandApproval";

export const RUNTIME_COMMAND_APPROVAL_MODES = [
  "manual",
  "ai",
  "automatic",
] as const;

export type RuntimeCommandApprovalMode =
  (typeof RUNTIME_COMMAND_APPROVAL_MODES)[number];

export function runtimeCommandApprovalMode(
  options?: Record<string, string>,
): RuntimeCommandApprovalMode {
  const mode = options?.[RUNTIME_COMMAND_APPROVAL_OPTION];
  return mode === "ai" || mode === "automatic" ? mode : "manual";
}
