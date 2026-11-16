// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type ResourceSource = "local" | "cloud";
export type ResourceScope = "all" | "mine" | "shared";
export type ResourceCatalogKind = "agents" | "teams" | "devices";

export function isDeviceDeletionProtected(
  device: import("../types").CollaborationExecutionEnvironment,
): boolean {
  return Boolean(
    device.is_current_device || device.is_current_device_candidate,
  );
}

export function canDeleteOfflineDevice(
  device: import("../types").CollaborationExecutionEnvironment,
  currentUserId?: number,
): boolean {
  return (
    currentUserId != null &&
    device.owner_type === "user" &&
    device.owner_id === String(currentUserId) &&
    device.status === "offline" &&
    !isDeviceDeletionProtected(device) &&
    Number.isSafeInteger(device.device_id) &&
    Number(device.device_id) > 0
  );
}

export function runtimeLabel(runtime: string) {
  const labels: Record<string, string> = {
    claude_code: "Claude Code",
    codex: "Codex",
    openclaw: "OpenClaw",
  };
  return (
    labels[runtime] ??
    runtime
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(" ")
  );
}

export function resourceCatalogCopy(
  kind: ResourceCatalogKind,
  messages: import("./platformMessages").PlatformMessages,
) {
  return {
    agents: {
      title: messages.agents,
      hint: messages.agentsPageHint,
      search: messages.searchAgents,
      create: messages.createAgent,
    },
    teams: {
      title: messages.teams,
      hint: messages.teamsPageHint,
      search: messages.searchTeams,
      create: messages.createTeam,
    },
    devices: {
      title: messages.devices,
      hint: messages.devicesPageHint,
      search: messages.searchDevices,
      create: messages.addDevice,
    },
  }[kind];
}
