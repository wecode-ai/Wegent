// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ProjectCreateCollaborationGroupDraft } from "./types";

type Participant = ProjectCreateCollaborationGroupDraft["leader"];

function sameParticipant(left: Participant, right: Participant) {
  return left.kind === right.kind && left.id === right.id;
}

export function changeCollaborationGroupLeader(
  draft: ProjectCreateCollaborationGroupDraft,
  identity: Pick<Participant, "kind" | "id">,
): ProjectCreateCollaborationGroupDraft {
  const selected = [draft.leader, ...draft.members].find(
    (candidate) =>
      candidate.kind === identity.kind && candidate.id === identity.id,
  );
  if (!selected || sameParticipant(selected, draft.leader)) return draft;
  return {
    ...draft,
    leader: { ...selected, responsibility: "" },
    members: [
      draft.leader,
      ...draft.members.filter(
        (candidate) => !sameParticipant(candidate, selected),
      ),
    ].filter(
      (candidate, index, candidates) =>
        candidates.findIndex((item) => sameParticipant(item, candidate)) ===
        index,
    ),
    stages: draft.stages.map((stage) => ({
      ...stage,
      assignee:
        stage.assignee && sameParticipant(stage.assignee, selected)
          ? null
          : stage.assignee,
    })),
  };
}

export function normalizeCollaborationGroupDraftForPersistence(
  draft: ProjectCreateCollaborationGroupDraft,
): ProjectCreateCollaborationGroupDraft {
  const leader = draft.leader;
  return {
    ...draft,
    leader,
    members: [leader, ...draft.members].filter(
      (candidate, index, candidates) =>
        candidates.findIndex((item) => sameParticipant(item, candidate)) ===
        index,
    ),
    stages: draft.stages.map((stage) => ({
      ...stage,
      assignee:
        stage.assignee && sameParticipant(stage.assignee, leader)
          ? null
          : stage.assignee,
    })),
  };
}
