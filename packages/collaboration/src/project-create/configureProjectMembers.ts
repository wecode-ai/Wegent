// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationMember,
  CollaborationWorkspaceMember,
} from "../types";

export interface ProjectCreateMemberFailure {
  userId: number;
  userName: string;
  reason: string;
}

export class ProjectCreateMembersError extends Error {
  readonly failures: ProjectCreateMemberFailure[];
  readonly members: CollaborationMember[];

  constructor(
    failures: ProjectCreateMemberFailure[],
    members: CollaborationMember[],
    message?: string,
  ) {
    super(
      message ??
        failures
          .map(({ userName, reason }) => `${userName}: ${reason}`)
          .join("\n"),
    );
    this.name = "ProjectCreateMembersError";
    this.failures = failures;
    this.members = members;
  }
}

interface ConfigureProjectMembersInput {
  api: Pick<SharedWorkspaceApi, "members">;
  projectId: string;
  memberUserIds: readonly number[];
  currentUserId: number;
  members?: readonly Pick<
    CollaborationWorkspaceMember,
    "user_id" | "user_name"
  >[];
  verificationFailureMessage?: string;
}

function failureReason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export async function configureProjectMembers({
  api,
  projectId,
  memberUserIds,
  currentUserId,
  members = [],
  verificationFailureMessage = "The member was not found in the project after saving",
}: ConfigureProjectMembersInput): Promise<CollaborationMember[]> {
  const selectedIds = [...new Set(memberUserIds)].filter(
    (userId) => userId !== currentUserId,
  );
  const describeFailure = (userId: number, reason: string) => ({
    userId,
    userName:
      members.find((member) => member.user_id === userId)?.user_name ??
      String(userId),
    reason,
  });
  let existingMembers: CollaborationMember[];
  try {
    existingMembers = await api.members.list(projectId);
  } catch (cause) {
    throw new ProjectCreateMembersError(
      selectedIds.map((userId) =>
        describeFailure(userId, failureReason(cause)),
      ),
      [],
      failureReason(cause),
    );
  }
  const existingIds = new Set(existingMembers.map((member) => member.user_id));
  const pendingIds = selectedIds.filter((userId) => !existingIds.has(userId));
  const results = await Promise.allSettled(
    pendingIds.map((userId) => api.members.add(projectId, userId, "Developer")),
  );
  const failures = new Map<number, string>();
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      failures.set(pendingIds[index], failureReason(result.reason));
    }
  });

  let verifiedMembers: CollaborationMember[];
  try {
    verifiedMembers = await api.members.list(projectId);
  } catch (cause) {
    throw new ProjectCreateMembersError(
      selectedIds.map((userId) =>
        describeFailure(userId, failures.get(userId) ?? failureReason(cause)),
      ),
      [],
      failureReason(cause),
    );
  }
  const verifiedIds = new Set(verifiedMembers.map((member) => member.user_id));
  const missingMembers = selectedIds
    .filter((userId) => !verifiedIds.has(userId))
    .map((userId) =>
      describeFailure(
        userId,
        failures.get(userId) ?? verificationFailureMessage,
      ),
    );
  if (missingMembers.length) {
    throw new ProjectCreateMembersError(missingMembers, verifiedMembers);
  }
  return verifiedMembers;
}
