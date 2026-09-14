// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { WorkspaceProjectAgent } from "../ports/SharedWorkspaceApi";
import type { CollaborationOwnedAgent } from "../types";

export interface ProjectAgentConfigurationRecord {
  id: string;
  name: string;
  runtime: "codex" | "wegent";
  status: "active" | "archived";
  version: number;
  wegentTeamId: number | null;
  capabilityDescription: string;
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
  const rawTeamId = value(row, "wegentTeamId", "wegent_team_id");
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
  name: string;
  capabilityDescription: string;
  systemPrompt: string;
}): Record<string, unknown> {
  return {
    name: options.name.trim(),
    runtime: "codex",
    capabilityDescription: options.capabilityDescription.trim(),
    systemPrompt: options.systemPrompt.trim(),
  };
}
