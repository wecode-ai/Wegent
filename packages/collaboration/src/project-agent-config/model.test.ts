// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { WorkspaceProjectAgent } from "../ports/SharedWorkspaceApi";
import type { CollaborationOwnedAgent } from "../types";
import {
  createLocalProjectAgentInput,
  createWegentProjectAgentInput,
  normalizeProjectAgent,
  parseProjectAgentSkillRefs,
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
      additionalSkills: [],
      mcpServers: {},
    });
  });

  it("parses stable Skill namespace references from the standard form", () => {
    expect(
      parseProjectAgentSkillRefs(
        "codex/wework-plugin-creator, project-space, platform/code-review",
      ),
    ).toEqual([
      { name: "wework-plugin-creator", namespace: "codex" },
      { name: "project-space", namespace: "default" },
      { name: "code-review", namespace: "platform" },
    ]);
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
      createLocalProjectAgentInput({
        name: " Codex 产品工程师 ",
        runtime: "codex",
        capabilityDescription: " 实现产品需求 ",
        model: "gpt-5.4",
        modelType: "runtime",
        modelOptions: { providerProfileId: "local" },
        systemPrompt: " 遵循项目规范 ",
        additionalSkills: [{ name: "review", namespace: "default" }],
        mcpServers: {
          repo: { command: "node", args: ["server.mjs"] },
        },
      }),
    ).toEqual({
      name: "Codex 产品工程师",
      runtime: "codex",
      capabilityDescription: "实现产品需求",
      model: "gpt-5.4",
      modelType: "runtime",
      modelOptions: { providerProfileId: "local" },
      systemPrompt: "遵循项目规范",
      additionalSkills: [{ name: "review", namespace: "default" }],
      mcpServers: {
        repo: { command: "node", args: ["server.mjs"] },
      },
    });
  });
});
