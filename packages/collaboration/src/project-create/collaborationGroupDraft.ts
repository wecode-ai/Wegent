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

/** Each generated responsibility event contributes one independent task item. */
export function appendCollaborationGroupResponsibility(
  current: string | undefined,
  text: string,
): string {
  return current ? `${current}\n${text}` : text;
}

export type GeneratedCollaborationGroupMissingSection = "principles" | "stages";

/** This contract applies only to completed AI generation, not editable drafts. */
export function missingGeneratedCollaborationGroupSections(
  draft: ProjectCreateCollaborationGroupDraft,
): GeneratedCollaborationGroupMissingSection[] {
  const missing: GeneratedCollaborationGroupMissingSection[] = [];
  if (!draft.instructions.trim()) missing.push("principles");
  if (draft.stages.length === 0) missing.push("stages");
  return missing;
}

export class IncompleteCollaborationGroupGenerationError extends Error {
  readonly missingSections: readonly GeneratedCollaborationGroupMissingSection[];

  constructor(
    missingSections: readonly GeneratedCollaborationGroupMissingSection[],
  ) {
    super("Generated collaboration group is incomplete");
    this.name = "IncompleteCollaborationGroupGenerationError";
    this.missingSections = [...missingSections];
  }
}
