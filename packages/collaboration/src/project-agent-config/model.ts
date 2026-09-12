// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { WorkspaceProjectAgent } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationExecutionEnvironment,
  CollaborationOwnedAgent,
  CollaborationProject,
} from "../types";

export interface ProjectAgentConfigurationRecord {
  id: string;
  name: string;
  runtime: "codex" | "wegent";
  status: "active" | "archived";
  version: number;
  wegentTeamId: number | null;
  capabilityDescription: string;
  executionEnvironment: "local" | "cloud";
  executionDeviceId: string | null;
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
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    runtime: runtime === "wegent" ? "wegent" : "codex",
    status: status === "archived" ? "archived" : "active",
    version: Number(value(row, "version", "version") ?? 1),
    wegentTeamId: rawTeamId == null ? null : Number(rawTeamId),
    capabilityDescription: String(
      value(row, "capabilityDescription", "capability_description") ?? "",
    ),
    executionEnvironment: executionEnvironment === "cloud" ? "cloud" : "local",
    executionDeviceId:
      rawDeviceId == null || rawDeviceId === "" ? null : String(rawDeviceId),
  };
}

export function createWegentProjectAgentInput(
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

export function createCodexProjectAgentInput(options: {
  project: CollaborationProject;
  environment: CollaborationExecutionEnvironment;
  name: string;
  capabilityDescription: string;
  systemPrompt: string;
}): Record<string, unknown> {
  const deviceKey = options.environment.device_key?.trim();
  if (!deviceKey) {
    throw new Error("Selected execution environment is missing device_key");
  }
  return {
    name: options.name.trim(),
    runtime: "codex",
    capabilityDescription: options.capabilityDescription.trim(),
    systemPrompt: options.systemPrompt.trim(),
    executionDeviceId: deviceKey,
    executionEnvironment:
      options.environment.kind === "cloud_host" ? "cloud" : "local",
    workspaceBinding: {
      type: "backend_project",
      projectId: options.project.id,
    },
  };
}
