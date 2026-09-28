// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveAgentPromptCapabilityReferences } from "./AgentPromptEditor";

describe("resolveAgentPromptCapabilityReferences", () => {
  const plugins = [
    {
      id: "social-media@official",
      pluginName: "social-media",
      marketplaceId: "official",
      displayName: "Social Media Ops",
    },
  ];
  const skills = [
    {
      id: 7,
      name: "review",
      namespace: "default",
      displayName: "Code Review",
    },
  ];

  it("turns Composer plugin and Skill mentions into capability dependencies", () => {
    const references = resolveAgentPromptCapabilityReferences(
      [
        "Use [$Social Media Ops](plugin://social-media@official)",
        "and [$review](skill:///default/review/SKILL.md).",
      ].join(" "),
      plugins,
      skills,
    );

    expect([...references.pluginIds]).toEqual(["social-media@official"]);
    expect([...references.skillIds]).toEqual([7]);
    expect([...references.skillKeys]).toEqual(["default:review"]);
  });

  it("ignores plain text and unknown references", () => {
    const references = resolveAgentPromptCapabilityReferences(
      "Use Social Media Ops and [$Unknown](plugin://unknown@official).",
      plugins,
      skills,
    );

    expect(references.pluginIds.size).toBe(0);
    expect(references.skillIds.size).toBe(0);
    expect(references.skillKeys.size).toBe(0);
  });
});
