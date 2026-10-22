import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";

/** Personal environments must be shared before a project can authorize them. */
export async function ensureWorkspaceEnvironmentSharing(
  api: SharedWorkspaceApi,
  workspaceId: string,
  deviceId: number,
  sharedDeviceIds: ReadonlySet<number>,
) {
  if (sharedDeviceIds.has(deviceId)) return null;
  if (!api.workspaces)
    throw new Error("Workspace environment sharing is unavailable");
  return api.workspaces.addExecutionEnvironment(workspaceId, { deviceId });
}
