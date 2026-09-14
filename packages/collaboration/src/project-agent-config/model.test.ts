// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { WorkspaceProjectAgent } from "../ports/SharedWorkspaceApi";
import type { CollaborationOwnedAgent } from "../types";
import {
  createCodexProjectAgentInput,
  createWegentProjectAgentInput,
  normalizeProjectAgent,
} from "./model";

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
      runtime: "codex",
      status: "active",
      version: 3,
      wegentTeamId: null,
      capabilityDescription: "实现需求",
      executionEnvironment: "cloud",
      executionDeviceId: "cloud-1",
      model: null,
      runtimeProfileId: null,
    });
  });

  it("creates the managed Wegent payload without execution environment fields", () => {
    expect(createWegentProjectAgentInput(team)).toEqual({
      name: "研发团队",
      runtime: "wegent",
      wegentTeamId: 12,
    });
  });

  it("creates the Codex payload without an execution environment binding", () => {
    expect(
      createCodexProjectAgentInput({
        name: " Codex 产品工程师 ",
        capabilityDescription: " 实现产品需求 ",
        systemPrompt: " 遵循项目规范 ",
      }),
    ).toEqual({
      name: "Codex 产品工程师",
      runtime: "codex",
      capabilityDescription: "实现产品需求",
      systemPrompt: "遵循项目规范",
    });
  });
});
