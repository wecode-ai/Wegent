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
        const index = saved.findIndex((entry) => entry.user_id === userId);
        const added: CollaborationMember =
          index < 0
            ? member(userId)
            : {
                ...saved[index],
                role: "Developer",
                direct_role: "Developer",
                permission_sources: [
                  ...(saved[index].permission_sources ?? []).filter(
                    (source) => source.type !== "direct",
                  ),
                  { type: "direct", role: "Developer" },
                ],
              };
        if (index < 0) saved.push(added);
        else saved[index] = added;
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
  it.each([
    { direct_role: null, inherited_role: "Viewer" },
    { direct_role: "Viewer", inherited_role: "Developer" },
  ] as const)(
    "promotes an explicitly selected Viewer with sources %j through a project grant",
    async (sources) => {
      const viewer: CollaborationMember = {
        ...member(2),
        role: "Viewer",
        ...sources,
        permission_sources: [
          { type: "workspace", role: sources.inherited_role },
        ],
      };
      const { api, add } = createMembersApi([member(1), viewer]);

      const verified = await configureProjectMembers({
        api,
        projectId: "project-1",
        currentUserId: 1,
        memberUserIds: [1, 2, 2],
      });

      expect(add).toHaveBeenCalledExactlyOnceWith("project-1", 2, "Developer");
      expect(verified.find((entry) => entry.user_id === 2)).toEqual({
        ...viewer,
        role: "Developer",
        direct_role: "Developer",
        inherited_role: sources.inherited_role,
        permission_sources: [
          { type: "workspace", role: sources.inherited_role },
          { type: "direct", role: "Developer" },
        ],
      });
    },
  );

  it("preserves existing Developer and higher roles without grants or downgrades", async () => {
    const existing: CollaborationMember[] = [
      { ...member(1), role: "Viewer" },
      { ...member(2), direct_role: "Developer", inherited_role: "Viewer" },
      {
        ...member(3),
        role: "Maintainer",
        direct_role: "Maintainer",
        inherited_role: "Developer",
      },
      { ...member(4), role: "Owner" },
      {
        ...member(5),
        role: "Maintainer",
        direct_role: null,
        inherited_role: "Maintainer",
      },
    ];
    const { api, add, list } = createMembersApi(existing);

    const verified = await configureProjectMembers({
      api,
      projectId: "project-1",
      currentUserId: 1,
      memberUserIds: [1, 2, 3, 3, 4, 5],
    });

    expect(add).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(2);
    expect(verified).toEqual(existing);
  });

  it("rejects a stale Viewer roster despite a Developer add response and retries only insufficient access", async () => {
    const viewer: CollaborationMember = {
      ...member(2),
      role: "Viewer",
      direct_role: null,
      inherited_role: "Viewer",
    };
    const { api, add } = createMembersApi([viewer, member(3)]);
    add.mockResolvedValueOnce({
      ...viewer,
      role: "Developer",
      direct_role: "Developer",
    });
    const input = {
      api,
      projectId: "project-1",
      currentUserId: 1,
      memberUserIds: [2, 3, 4],
      members: [viewer, member(3), member(4)],
      verificationFailureMessage: "Member has not received Developer access",
    };

    await expect(configureProjectMembers(input)).rejects.toMatchObject({
      name: "ProjectCreateMembersError",
      failures: [
        {
          userId: 2,
          userName: "User 2",
          reason: "Member has not received Developer access",
        },
      ],
      members: [member(3), member(4)],
    });
    expect(add.mock.calls.map(([, userId]) => userId)).toEqual([2, 4]);

    const verified = await configureProjectMembers(input);

    expect(add.mock.calls.map(([, userId]) => userId)).toEqual([2, 4, 2]);
    expect(verified.find((entry) => entry.user_id === 2)).toMatchObject({
      role: "Developer",
      direct_role: "Developer",
      inherited_role: "Viewer",
    });
    expect(verified.map((entry) => entry.user_id)).toEqual([2, 3, 4]);
  });

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

  it("keeps an initial roster failure retryable without writing until membership is known", async () => {
    const { api, list, add } = createMembersApi([member(1)]);
    list.mockRejectedValueOnce(new Error("Permission denied"));
    const input = {
      api,
      projectId: "project-1",
      currentUserId: 1,
      memberUserIds: [2],
      members: [member(2)],
    };

    await expect(configureProjectMembers(input)).rejects.toMatchObject({
      name: "ProjectCreateMembersError",
      failures: [
        { userId: 2, userName: "User 2", reason: "Permission denied" },
      ],
    });
    expect(add).not.toHaveBeenCalled();
    await expect(configureProjectMembers(input)).resolves.toEqual([
      member(1),
      member(2),
    ]);
    expect(add).toHaveBeenCalledExactlyOnceWith("project-1", 2, "Developer");
  });
});
