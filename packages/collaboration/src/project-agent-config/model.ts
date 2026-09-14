// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { WorkspaceProjectAgent } from "../ports/SharedWorkspaceApi";
import type { CollaborationOwnedAgent } from "../types";

export interface ProjectAgentConfigurationRecord {
  id: string;
  name: string;
  runtime: "codex" | "claude_code" | "wegent";
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
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    runtime:
      runtime === "wegent"
        ? "wegent"
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

export function createLocalProjectAgentInput(options: {
  name: string;
  runtime: "codex" | "claude_code";
  capabilityDescription: string;
  model: string;
  modelOptions: Record<string, string>;
  modelType: "public" | "user" | "group" | "runtime" | null;
  systemPrompt: string;
  additionalSkills: unknown[];
  mcpServers: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    name: options.name.trim(),
    runtime: options.runtime,
    capabilityDescription: options.capabilityDescription.trim(),
    model: options.model,
    modelType: options.modelType,
    modelOptions: options.modelOptions,
    systemPrompt: options.systemPrompt.trim(),
    additionalSkills: options.additionalSkills,
    mcpServers: options.mcpServers,
  };
}

export function parseProjectAgentSkillRefs(value: string): Array<{
  name: string;
  namespace: string;
}> {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("/");
      if (separator <= 0 || separator === entry.length - 1) {
        return { name: entry, namespace: "default" };
      }
      return {
        namespace: entry.slice(0, separator).trim(),
        name: entry.slice(separator + 1).trim(),
      };
    })
    .filter((skill) => skill.name && skill.namespace);
}
