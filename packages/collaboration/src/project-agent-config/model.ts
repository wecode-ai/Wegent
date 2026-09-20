// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { WorkspaceProjectAgent } from "../ports/SharedWorkspaceApi";
import type { CollaborationOwnedAgent } from "../types";

export interface ProjectAgentConfigurationRecord {
  id: string;
  name: string;
  displayName: string;
  definitionSource: "project" | "shared_agent";
  executorType: "codex" | "claude_code" | null;
  status: "active" | "archived";
  version: number;
  wegentTeamId: number | null;
  capabilityDescription: string;
  executionEnvironment: "local" | "cloud";
  executionDeviceId: string | null;
  model: string | null;
  runtimeProfileId: string | null;
  additionalSkills: unknown[];
  mcpServers: Record<string, unknown>;
}

function value(
  row: WorkspaceProjectAgent,
  camel: string,
  snake: string,
): unknown {
  return row[camel] ?? row[snake];
}

export function normalizeProjectAgent(
  row: WorkspaceProjectAgent,
): ProjectAgentConfigurationRecord {
  const runtime = value(row, "runtime", "runtime");
  const status = value(row, "status", "status");
  const executionEnvironment = value(
    row,
    "executionEnvironment",
    "execution_environment",
  );
  const rawTeamId = value(row, "wegentTeamId", "wegent_team_id");
  const rawDeviceId = value(row, "executionDeviceId", "execution_device_id");
  const name = String(row.name ?? "");
  const displayName = String(value(row, "displayName", "display_name") ?? name);
  return {
    id: String(row.id),
    name,
    displayName,
    definitionSource: rawTeamId == null ? "project" : "shared_agent",
    executorType:
      runtime === "wegent"
        ? null
        : runtime === "claude_code"
          ? "claude_code"
          : "codex",
    status: status === "archived" ? "archived" : "active",
    version: Number(value(row, "version", "version") ?? 1),
    wegentTeamId: rawTeamId == null ? null : Number(rawTeamId),
    capabilityDescription: String(
      value(row, "capabilityDescription", "capability_description") ?? "",
    ),
    executionEnvironment: executionEnvironment === "cloud" ? "cloud" : "local",
    executionDeviceId:
      rawDeviceId == null || rawDeviceId === "" ? null : String(rawDeviceId),
    model: typeof row.model === "string" && row.model.trim() ? row.model : null,
    runtimeProfileId:
      String(
        value(row, "defaultRuntimeProfileId", "default_runtime_profile_id") ||
          "",
      ) || null,
    additionalSkills: Array.isArray(
      value(row, "additionalSkills", "additional_skills"),
    )
      ? (value(row, "additionalSkills", "additional_skills") as unknown[])
      : [],
    mcpServers:
      typeof value(row, "mcpServers", "mcp_servers") === "object" &&
      value(row, "mcpServers", "mcp_servers") !== null
        ? (value(row, "mcpServers", "mcp_servers") as Record<string, unknown>)
        : {},
  };
}

export function createSharedAgentBindingInput(
  team: CollaborationOwnedAgent,
): Record<string, unknown> {
  if (!team.team_id) {
    throw new Error("Selected Wegent Agent is missing team_id");
  }
  return {
    name: team.name,
    runtime: "wegent",
    wegentTeamId: team.team_id,
  };
}
