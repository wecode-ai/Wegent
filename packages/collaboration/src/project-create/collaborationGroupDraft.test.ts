// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  changeCollaborationGroupLeader,
  normalizeCollaborationGroupDraftForPersistence,
} from "./collaborationGroupDraft";
import type { ProjectCreateCollaborationGroupDraft } from "./types";

const draft: ProjectCreateCollaborationGroupDraft = {
  name: "Delivery team",
  description: "",
  instructions: "",
  leader: { kind: "agent", id: "manager", responsibility: "" },
  members: [
    { kind: "human", id: "7", responsibility: "Verify delivery" },
    { kind: "agent", id: "worker", responsibility: "Implement" },
  ],
  stages: [
    {
      id: "verify",
      name: "Verify",
      description: "",
      assignee: {
        kind: "human",
        id: "7",
        responsibility: "Verify delivery",
      },
    },
  ],
  executionRequirements: { requiredTags: [] },
};

describe("collaborationGroupDraft", () => {
  it("keeps either a human or an Agent leader out of execution stages", () => {
    const humanLed = changeCollaborationGroupLeader(draft, {
      kind: "human",
      id: "7",
    });

    expect(humanLed.leader).toEqual({
      kind: "human",
      id: "7",
      responsibility: "",
    });
    expect(humanLed.members).toContainEqual(draft.leader);
    expect(humanLed.members).not.toContainEqual(
      expect.objectContaining({ kind: "human", id: "7" }),
    );
    expect(humanLed.stages[0]?.assignee).toBeNull();
  });

  it("includes the coordinating leader in the persisted group roster", () => {
    const normalized = normalizeCollaborationGroupDraftForPersistence(draft);

    expect(normalized.members).toEqual([draft.leader, ...draft.members]);
    expect(normalized.stages[0]?.assignee).toEqual(draft.stages[0]?.assignee);
  });
});
