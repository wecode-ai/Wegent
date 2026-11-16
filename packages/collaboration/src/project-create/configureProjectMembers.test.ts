// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type { CollaborationMember } from "../types";
import {
  configureProjectMembers,
  ProjectCreateMembersError,
} from "./configureProjectMembers";

function member(userId: number): CollaborationMember {
  return {
    id: userId,
    user_id: userId,
    user_name: `User ${userId}`,
    email: null,
    role: "Developer",
  };
}

function createMembersApi(initialMembers: CollaborationMember[] = []) {
  const saved = [...initialMembers];
  const api = {
    members: {
      list: vi.fn(async () => [...saved]),
      add: vi.fn(async (_projectId: string, userId: number) => {
        const added = member(userId);
        saved.push(added);
        return added;
      }),
    },
  };
  return {
    api: api as unknown as Pick<SharedWorkspaceApi, "members">,
    list: api.members.list,
    add: api.members.add,
    saved,
  };
}

describe("configureProjectMembers", () => {
  it("adds unique missing collaborators as Developer and returns the server roster", async () => {
    const { api, add, list } = createMembersApi([member(1), member(2)]);

    const verified = await configureProjectMembers({
      api,
      projectId: "project-1",
      currentUserId: 1,
      memberUserIds: [1, 2, 3, 3, 4],
    });

    expect(add.mock.calls).toEqual([
      ["project-1", 3, "Developer"],
      ["project-1", 4, "Developer"],
    ]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(verified.map(({ user_id }) => user_id)).toEqual([1, 2, 3, 4]);
    expect(list.mock.invocationCallOrder[1]).toBeGreaterThan(
      add.mock.invocationCallOrder[1],
    );
  });

  it("retains each failed member and reason, then retries only missing members", async () => {
    const { api, add, saved } = createMembersApi([member(1)]);
    add.mockImplementationOnce(async () => {
      saved.push(member(2));
      return member(2);
    });
    add.mockRejectedValueOnce(new Error("Permission denied"));
    const input = {
      api,
      projectId: "project-1",
      currentUserId: 1,
      memberUserIds: [2, 3],
      members: [member(2), member(3)],
    };

    const failure = await configureProjectMembers(input).catch(
      (cause) => cause,
    );

    expect(failure).toBeInstanceOf(ProjectCreateMembersError);
    expect(failure.failures).toEqual([
      { userId: 3, userName: "User 3", reason: "Permission denied" },
    ]);
    expect(
      failure.members.map(({ user_id }: CollaborationMember) => user_id),
    ).toEqual([1, 2]);
    expect(failure.message).toContain("User 3: Permission denied");

    const verified = await configureProjectMembers(input);

    expect(add.mock.calls.map(([, userId]) => userId)).toEqual([2, 3, 3]);
    expect(verified.map(({ user_id }) => user_id)).toEqual([1, 2, 3]);
  });

  it("uses the server roster when an add response is lost after persistence", async () => {
    const { api, add, saved } = createMembersApi();
    add.mockImplementationOnce(async () => {
      saved.push(member(2));
      throw new Error("Connection closed");
    });

    await expect(
      configureProjectMembers({
        api,
        projectId: "project-1",
        currentUserId: 1,
        memberUserIds: [2],
      }),
    ).resolves.toEqual([member(2)]);
  });

  it("rejects success responses until the selected members appear on the server", async () => {
    const { api, add } = createMembersApi();
    add.mockResolvedValue(member(2));

    await expect(
      configureProjectMembers({
        api,
        projectId: "project-1",
        currentUserId: 1,
        memberUserIds: [2],
        members: [member(2)],
        verificationFailureMessage: "Member was not saved",
      }),
    ).rejects.toMatchObject({
      failures: [
        { userId: 2, userName: "User 2", reason: "Member was not saved" },
      ],
      members: [],
    });
  });

  it("retains a verification failure and retries without adding saved members twice", async () => {
    const { api, add, list } = createMembersApi();
    list
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("Roster unavailable"));
    const input = {
      api,
      projectId: "project-1",
      currentUserId: 1,
      memberUserIds: [2],
    };

    await expect(configureProjectMembers(input)).rejects.toMatchObject({
      failures: [{ userId: 2, reason: "Roster unavailable" }],
    });
    await expect(configureProjectMembers(input)).resolves.toEqual([member(2)]);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("preserves a roster read error when no additional members were selected", async () => {
    const { api, list } = createMembersApi();
    list
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("Roster unavailable"));

    await expect(
      configureProjectMembers({
        api,
        projectId: "project-1",
        currentUserId: 1,
        memberUserIds: [],
      }),
    ).rejects.toThrow("Roster unavailable");
  });
});
