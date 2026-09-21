// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { WorkspaceProjectAgent } from "../ports/SharedWorkspaceApi";
import type { CollaborationOwnedAgent } from "../types";
import { createSharedAgentBindingInput, normalizeProjectAgent } from "./model";

const team: CollaborationOwnedAgent = {
  id: "workspace-agent-1",
  name: "研发团队",
  team_id: 12,
  owner_type: "workspace",
  owner_id: "workspace-1",
  owner_name: "研发空间",
  status: "available",
  execution_environment_ids: [],
};

describe("project agent configuration model", () => {
  it("normalizes snake_case and camelCase project agent DTOs", () => {
    expect(
      normalizeProjectAgent({
        id: "agent-1",
        name: "Codex",
        runtime: "codex",
        status: "active",
        version: 3,
        execution_environment: "cloud",
        execution_device_id: "cloud-1",
        capability_description: "实现需求",
      } as WorkspaceProjectAgent),
    ).toEqual({
      id: "agent-1",
      name: "Codex",
      displayName: "Codex",
      definitionSource: "project",
      executorType: "codex",
      status: "active",
      version: 3,
      wegentTeamId: null,
      capabilityDescription: "实现需求",
      executionEnvironment: "cloud",
      executionDeviceId: "cloud-1",
      model: null,
      runtimeProfileId: null,
      additionalSkills: [],
      mcpServers: {},
    });
  });

  it("creates a shared Agent binding without treating its source as an executor type", () => {
    expect(createSharedAgentBindingInput(team)).toEqual({
      name: "研发团队",
      runtime: "wegent",
      wegentTeamId: 12,
    });
  });

  it("uses the referenced Agent identity rather than its execution route as the definition source", () => {
    expect(
      normalizeProjectAgent({
        id: "agent-2",
        name: "共享评审智能体",
        runtime: "wegent",
        status: "active",
        version: 1,
        wegent_team_id: 12,
      } as WorkspaceProjectAgent),
    ).toMatchObject({
      definitionSource: "shared_agent",
      executorType: null,
      wegentTeamId: 12,
    });
  });

  it("does not treat Wegent hosting as an Agent definition source", () => {
    expect(
      normalizeProjectAgent({
        id: "agent-3",
        name: "项目托管智能体",
        runtime: "wegent",
        status: "active",
        version: 1,
      } as WorkspaceProjectAgent),
    ).toMatchObject({
      definitionSource: "project",
      executorType: null,
      wegentTeamId: null,
    });
  });

  it("falls back to the resource name when the display name is blank", () => {
    expect(
      normalizeProjectAgent({
        id: "agent-blank-display-name",
        name: "项目智能体",
        display_name: "   ",
        runtime: "codex",
        status: "active",
        version: 1,
      } as WorkspaceProjectAgent),
    ).toMatchObject({
      name: "项目智能体",
      displayName: "项目智能体",
    });
  });

  it("keeps a shared Agent source independent from a resolved executor type", () => {
    expect(
      normalizeProjectAgent({
        id: "agent-4",
        name: "共享 Codex 智能体",
        runtime: "codex",
        status: "active",
        version: 1,
        wegent_team_id: 12,
      } as WorkspaceProjectAgent),
    ).toMatchObject({
      definitionSource: "shared_agent",
      executorType: "codex",
      wegentTeamId: 12,
    });
  });
});
