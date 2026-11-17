import type { RuntimeWorktreeCapability } from "./execution-project";
import type { RuntimeDeviceWorkspace } from "./runtime-task-api-types";
import type {
  RuntimeWorktreeCapabilitiesRequest,
  RuntimeWorktreeCapabilitiesResponse,
  RuntimeWorktreePreflightRequest,
  RuntimeWorktreePreflightResponse,
} from "./worktree-types";

export interface WorktreeDevice {
  device_id: string;
  device_type?: string;
  status: string;
  runtime_routes?: readonly { device_id: string }[] | null;
  runtime_features?: { worktrees?: RuntimeWorktreeCapability | null } | null;
}

export type ProjectWorktreeAvailabilityReason =
  | "available"
  | "no_project"
  | "project_ineligible"
  | "no_workspace"
  | "workspace_unavailable"
  | "workspace_not_base"
  | "source_path_missing"
  | "device_not_found"
  | "device_mismatch"
  | "device_offline"
  | "executor_unsupported"
  | "persistent_storage_unverified"
  | "preflight_pending"
  | "preflight_failed"
  | "not_git"
  | "worktree_root_unwritable"
  | "workspace_identity_mismatch";

export interface ProjectWorktreeAvailability {
  available: boolean;
  reason: ProjectWorktreeAvailabilityReason;
  deviceId: string | null;
  sourcePath: string | null;
}

export interface ResolveWorkspaceWorktreeAvailabilityInput {
  projectUnavailableReason?: "no_project" | "project_ineligible";
  workspace: RuntimeDeviceWorkspace | null | undefined;
  device: WorktreeDevice | null | undefined;
  capabilities?: RuntimeWorktreeCapabilitiesResponse | null;
  preflight?: RuntimeWorktreePreflightResponse | null;
}

export interface ProjectWorktreeAvailabilityApi {
  getWorktreeCapabilities(
    data: RuntimeWorktreeCapabilitiesRequest,
  ): Promise<RuntimeWorktreeCapabilitiesResponse>;
  preflightWorktree(
    data: RuntimeWorktreePreflightRequest,
  ): Promise<RuntimeWorktreePreflightResponse>;
}

export interface ProbeWorkspaceWorktreeAvailabilityInput extends Omit<
  ResolveWorkspaceWorktreeAvailabilityInput,
  "capabilities" | "preflight"
> {
  api: ProjectWorktreeAvailabilityApi;
  ref?: string | null;
}

const worktreeProbeInflight = new WeakMap<
  ProjectWorktreeAvailabilityApi,
  Map<string, Promise<ProjectWorktreeAvailability>>
>();

function unavailable(
  reason: Exclude<ProjectWorktreeAvailabilityReason, "available">,
  deviceId: string | null,
  sourcePath: string | null,
): ProjectWorktreeAvailability {
  return {
    available: false,
    reason,
    deviceId,
    sourcePath,
  };
}

export function worktreeWorkspaceDeviceId(
  workspace: RuntimeDeviceWorkspace | null | undefined,
): string | null {
  if (!workspace) return null;
  const remoteHostId = workspace.remoteHostId?.trim();
  if (workspace.workspaceSource === "remote" && remoteHostId)
    return remoteHostId;
  return workspace.deviceId.trim() || null;
}

function deviceMatches(device: WorktreeDevice, deviceId: string): boolean {
  if (device.device_id.trim() === deviceId) return true;
  return Boolean(
    device.runtime_routes?.some((route) => route.device_id.trim() === deviceId),
  );
}

function projectedWorktreeCapability(
  device: Pick<WorktreeDevice, "runtime_features">,
): RuntimeWorktreeCapability | null {
  const runtimeFeatures = device.runtime_features;
  if (!runtimeFeatures) return null;
  return runtimeFeatures.worktrees ?? null;
}

function supportsManagedWorktreeCapability(
  capability: RuntimeWorktreeCapability | null,
): boolean {
  return Boolean(
    capability &&
    capability.version >= 1 &&
    capability.managed &&
    capability.preflight,
  );
}

function requiresPersistentStorageVerification(
  device: Pick<WorktreeDevice, "device_type">,
): boolean {
  return device.device_type !== "local" && device.device_type !== "app";
}

function hasVerifiedPersistentStorage(
  device: Pick<WorktreeDevice, "device_type">,
  capability: RuntimeWorktreeCapability | null,
): boolean {
  return (
    !requiresPersistentStorageVerification(device) ||
    capability?.persistentStorageVerified === true
  );
}

export function deviceSupportsManagedWorktrees(
  device: Pick<WorktreeDevice, "device_type" | "runtime_features">,
): boolean {
  const capability = projectedWorktreeCapability(device);
  return (
    supportsManagedWorktreeCapability(capability) &&
    hasVerifiedPersistentStorage(device, capability)
  );
}

function preflightFailureReason(
  preflight: RuntimeWorktreePreflightResponse,
): Exclude<ProjectWorktreeAvailabilityReason, "available"> | null {
  if (!preflight.success) return "preflight_failed";
  if (!preflight.supported) return "executor_unsupported";
  if (!preflight.sourceExists || !preflight.sourceDirectory)
    return "source_path_missing";
  if (!preflight.gitRepository || !preflight.gitCommonDirValid)
    return "not_git";
  if (!preflight.gitCommonDirWritable || !preflight.writable) {
    return "worktree_root_unwritable";
  }

  switch (preflight.errorCode) {
    case null:
    case undefined:
      return null;
    case "runtime_feature_unsupported":
    case "worktree_unsupported":
      return "executor_unsupported";
    case "worktree_source_missing":
      return "source_path_missing";
    case "worktree_source_not_git":
      return "not_git";
    case "worktree_git_common_dir_unwritable":
    case "worktree_root_unwritable":
      return "worktree_root_unwritable";
    case "worktree_source_changed":
      return "workspace_identity_mismatch";
    default:
      return "preflight_failed";
  }
}

export function resolveWorkspaceWorktreeAvailability({
  projectUnavailableReason,
  workspace,
  device,
  capabilities,
  preflight,
}: ResolveWorkspaceWorktreeAvailabilityInput): ProjectWorktreeAvailability {
  const deviceId = worktreeWorkspaceDeviceId(workspace);
  const sourcePath = workspace?.workspacePath.trim() || null;

  const structuralFailure = resolveStructuralFailure({
    projectUnavailableReason,
    workspace,
    device,
    deviceId,
    sourcePath,
  });
  if (structuralFailure) return structuralFailure;
  if (!workspace) return unavailable("no_workspace", null, null);
  if (!device) return unavailable("device_not_found", deviceId, sourcePath);

  if (
    capabilities &&
    capabilities.deviceId !== deviceId &&
    !deviceMatches(device, capabilities.deviceId)
  ) {
    return unavailable("device_mismatch", deviceId, sourcePath);
  }
  if (capabilities && !capabilities.success) {
    return unavailable("executor_unsupported", deviceId, sourcePath);
  }

  const capability =
    capabilities === undefined
      ? projectedWorktreeCapability(device)
      : (capabilities?.runtimeWorktrees ?? null);
  if (!supportsManagedWorktreeCapability(capability)) {
    return unavailable("executor_unsupported", deviceId, sourcePath);
  }
  if (!hasVerifiedPersistentStorage(device, capability)) {
    return unavailable("persistent_storage_unverified", deviceId, sourcePath);
  }
  if (preflight === undefined || preflight === null) {
    return unavailable("preflight_pending", deviceId, sourcePath);
  }
  if (
    preflight.deviceId !== deviceId &&
    !deviceMatches(device, preflight.deviceId)
  ) {
    return unavailable("preflight_failed", deviceId, sourcePath);
  }
  const preflightFailure = preflightFailureReason(preflight);
  if (preflightFailure) {
    return unavailable(preflightFailure, deviceId, sourcePath);
  }
  if (
    workspace.repoRootFingerprint &&
    preflight.repoRootFingerprint &&
    workspace.repoRootFingerprint !== preflight.repoRootFingerprint
  ) {
    return unavailable("workspace_identity_mismatch", deviceId, sourcePath);
  }
  if (!preflight.repoRoot?.trim() || !preflight.resolvedWorktreeRoot?.trim()) {
    return unavailable("preflight_failed", deviceId, sourcePath);
  }

  return {
    available: true,
    reason: "available",
    deviceId,
    sourcePath,
  };
}

function resolveStructuralFailure({
  projectUnavailableReason,
  workspace,
  device,
  deviceId,
  sourcePath,
}: ResolveWorkspaceWorktreeAvailabilityInput & {
  deviceId: string | null;
  sourcePath: string | null;
}): ProjectWorktreeAvailability | null {
  if (projectUnavailableReason)
    return unavailable(projectUnavailableReason, deviceId, sourcePath);
  if (!workspace) return unavailable("no_workspace", null, null);
  if (!workspace.available) {
    return unavailable("workspace_unavailable", deviceId, sourcePath);
  }
  if (workspace.workspaceKind === "worktree" || workspace.worktreeId) {
    return unavailable("workspace_not_base", deviceId, sourcePath);
  }
  if (!sourcePath) return unavailable("source_path_missing", deviceId, null);
  if (!device) return unavailable("device_not_found", deviceId, sourcePath);
  if (!deviceId || !deviceMatches(device, deviceId)) {
    return unavailable("device_mismatch", deviceId, sourcePath);
  }
  if (device.status !== "online" && device.status !== "busy") {
    return unavailable("device_offline", deviceId, sourcePath);
  }
  return null;
}

function structuralAvailability(
  input: Omit<
    ResolveWorkspaceWorktreeAvailabilityInput,
    "capabilities" | "preflight"
  >,
): ProjectWorktreeAvailability {
  const deviceId = worktreeWorkspaceDeviceId(input.workspace);
  const sourcePath = input.workspace?.workspacePath.trim() || null;
  return (
    resolveStructuralFailure({
      ...input,
      deviceId,
      sourcePath,
    }) ?? unavailable("preflight_pending", deviceId, sourcePath)
  );
}

function failedProbeAvailability(
  input: Omit<
    ResolveWorkspaceWorktreeAvailabilityInput,
    "capabilities" | "preflight"
  >,
): ProjectWorktreeAvailability {
  const structural = structuralAvailability(input);
  if (structural.reason !== "preflight_pending") return structural;
  return unavailable(
    "preflight_failed",
    structural.deviceId,
    structural.sourcePath,
  );
}

async function probeWorkspaceWorktreeAvailabilityUncached({
  api,
  projectUnavailableReason,
  workspace,
  device,
  ref,
}: ProbeWorkspaceWorktreeAvailabilityInput): Promise<ProjectWorktreeAvailability> {
  const input = { projectUnavailableReason, workspace, device };
  const structural = structuralAvailability(input);
  if (
    structural.reason !== "preflight_pending" ||
    !structural.deviceId ||
    !structural.sourcePath
  ) {
    return structural;
  }

  try {
    const capabilities = await api.getWorktreeCapabilities({
      deviceId: structural.deviceId,
    });
    const capabilityAvailability = resolveWorkspaceWorktreeAvailability({
      ...input,
      capabilities,
      preflight: null,
    });
    if (capabilityAvailability.reason !== "preflight_pending") {
      return capabilityAvailability;
    }

    const preflight = await api.preflightWorktree({
      deviceId: structural.deviceId,
      sourcePath: structural.sourcePath,
      ...(ref?.trim() ? { ref: ref.trim() } : {}),
    });
    return resolveWorkspaceWorktreeAvailability({
      ...input,
      capabilities,
      preflight,
    });
  } catch (error) {
    console.error("[Wework] Worktree availability probe failed", error);
    return failedProbeAvailability(input);
  }
}

export function probeWorkspaceWorktreeAvailability(
  input: ProbeWorkspaceWorktreeAvailabilityInput,
): Promise<ProjectWorktreeAvailability> {
  const structural = structuralAvailability(input);
  if (
    structural.reason !== "preflight_pending" ||
    !structural.deviceId ||
    !structural.sourcePath
  ) {
    return Promise.resolve(structural);
  }

  const key = JSON.stringify([
    structural.deviceId,
    structural.sourcePath,
    input.ref?.trim() ?? "",
    input.workspace?.repoRootFingerprint ?? "",
    input.device?.device_id ?? "",
    input.device?.device_type ?? "",
    input.device?.status ?? "",
    input.device?.runtime_routes ?? [],
  ]);
  const probes = worktreeProbeInflight.get(input.api) ?? new Map();
  worktreeProbeInflight.set(input.api, probes);
  const existing = probes.get(key);
  if (existing) return existing;

  const probe = probeWorkspaceWorktreeAvailabilityUncached(input).finally(
    () => {
      if (probes.get(key) === probe) probes.delete(key);
    },
  );
  probes.set(key, probe);
  return probe;
}
