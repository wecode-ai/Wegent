// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { WorkspaceProjectAgent } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationExecutionEnvironment,
  CollaborationOwnedAgent,
  CollaborationProject,
} from "../types";
import {
  createCodexProjectAgentInput,
  createWegentProjectAgentInput,
  normalizeProjectAgent,
} from "./model";

const project = {
  id: "8869148083931743937",
} as CollaborationProject;

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

const environment: CollaborationExecutionEnvironment = {
  id: "environment-1",
  device_id: 22,
  device_key: "device-macbook",
  name: "MacBook Pro",
  kind: "local_device",
  owner_type: "user",
  owner_id: "7",
  owner_name: "李明",
  status: "online",
  updated_at: "2026-09-12T00:00:00Z",
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
    });
  });

  it("creates the managed Wegent payload without execution environment fields", () => {
    expect(createWegentProjectAgentInput(team)).toEqual({
      name: "研发团队",
      runtime: "wegent",
      wegentTeamId: 12,
    });
  });

  it("creates the Codex payload with a real device key and backend project binding", () => {
    expect(
      createCodexProjectAgentInput({
        project,
        environment,
        name: " Codex 产品工程师 ",
        capabilityDescription: " 实现产品需求 ",
        systemPrompt: " 遵循项目规范 ",
      }),
    ).toEqual({
      name: "Codex 产品工程师",
      runtime: "codex",
      capabilityDescription: "实现产品需求",
      systemPrompt: "遵循项目规范",
      executionDeviceId: "device-macbook",
      executionEnvironment: "local",
      workspaceBinding: {
        type: "backend_project",
        projectId: "8869148083931743937",
      },
    });
  });

  it("rejects execution environments that cannot address an executor", () => {
    expect(() =>
      createCodexProjectAgentInput({
        project,
        environment: { ...environment, device_key: undefined },
        name: "Codex",
        capabilityDescription: "",
        systemPrompt: "",
      }),
    ).toThrow("device_key");
  });
});
