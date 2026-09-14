// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from "react";

import type { CollaborationPriority } from "../types";

export type IssueAssigneeTarget =
  | ""
  | `user:${number}`
  | `agent:${string}`
  | `team:${number}`;

export interface IssueDetailDraftSource<TWorkflow = unknown> {
  id: string;
  version: number;
  title: string;
  description: string;
  status: string;
  priority: CollaborationPriority;
  parent_id: string | null;
  due_at: string | null;
  tags: string[];
  assignee_user_id?: number | null;
  assignee_agent_id?: string | null;
  assignee_team_id?: number | null;
  workflow?: TWorkflow | null;
}

export interface IssueDetailDraftValue<TWorkflow = unknown> {
  title: string;
  description: string;
  status: string;
  priority: CollaborationPriority;
  parentId: string;
  dueDate: string;
  tags: string[];
  assigneeTarget: IssueAssigneeTarget;
  workflow: TWorkflow | null;
}

export interface IssueDetailDraftInitial<TWorkflow = unknown> extends Partial<
  IssueDetailDraftValue<TWorkflow>
> {
  title: string;
  description: string;
  status: string;
  priority: CollaborationPriority;
}

export interface IssueDetailDraftOptions<TWorkflow = unknown> {
  source: IssueDetailDraftSource<TWorkflow> | null;
  initial: IssueDetailDraftInitial<TWorkflow>;
  normalizeDescription?: (description: string) => string;
  dueDateFromSource?: (dueAt: string | null) => string;
}

export function issueAssigneeTarget(
  source: Pick<
    IssueDetailDraftSource,
    "assignee_user_id" | "assignee_agent_id" | "assignee_team_id"
  >,
): IssueAssigneeTarget {
  if (source.assignee_team_id) return `team:${source.assignee_team_id}`;
  if (source.assignee_agent_id) return `agent:${source.assignee_agent_id}`;
  if (source.assignee_user_id) return `user:${source.assignee_user_id}`;
  return "";
}

export function parseIssueAssigneeTarget(target: IssueAssigneeTarget): {
  assigneeUserId: number | null;
  assigneeAgentId: string | null;
  assigneeTeamId: number | null;
} {
  return {
    assigneeUserId: target.startsWith("user:") ? Number(target.slice(5)) : null,
    assigneeAgentId: target.startsWith("agent:") ? target.slice(6) : null,
    assigneeTeamId: target.startsWith("team:") ? Number(target.slice(5)) : null,
  };
}

function equalTags(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((tag, index) => tag === right[index])
  );
}

function defaultDueDate(dueAt: string | null): string {
  return dueAt?.slice(0, 16) ?? "";
}

function identityDescription(description: string): string {
  return description;
}

function draftFromSource<TWorkflow>(
  source: IssueDetailDraftSource<TWorkflow>,
  normalizeDescription: (description: string) => string,
  dueDateFromSource: (dueAt: string | null) => string,
): IssueDetailDraftValue<TWorkflow> {
  return {
    title: source.title ?? "",
    description: normalizeDescription(source.description ?? ""),
    status: source.status ?? "",
    priority: source.priority ?? "none",
    parentId: source.parent_id ?? "",
    dueDate: dueDateFromSource(source.due_at),
    tags: source.tags ?? [],
    assigneeTarget: issueAssigneeTarget(source),
    workflow: source.workflow ?? null,
  };
}

export function useIssueDetailDraft<TWorkflow = unknown>({
  source,
  initial,
  normalizeDescription = identityDescription,
  dueDateFromSource = defaultDueDate,
}: IssueDetailDraftOptions<TWorkflow>) {
  const initialValue: IssueDetailDraftValue<TWorkflow> = {
    title: initial.title,
    description: initial.description,
    status: initial.status,
    priority: initial.priority,
    parentId: initial.parentId ?? "",
    dueDate: initial.dueDate ?? "",
    tags: initial.tags ?? [],
    assigneeTarget: initial.assigneeTarget ?? "",
    workflow: initial.workflow ?? null,
  };
  const [draft, setDraft] = useState<IssueDetailDraftValue<TWorkflow>>(() =>
    source
      ? draftFromSource(source, normalizeDescription, dueDateFromSource)
      : initialValue,
  );
  const syncedSourceRef = useRef<IssueDetailDraftSource<TWorkflow> | null>(
    source,
  );

  useEffect(() => {
    if (!source) return;
    const previous = syncedSourceRef.current;
    if (previous === source) return;

    const sameIssue = previous?.id === source.id;
    const previousDraft = previous
      ? draftFromSource(previous, normalizeDescription, dueDateFromSource)
      : null;
    const nextDraft = draftFromSource(
      source,
      normalizeDescription,
      dueDateFromSource,
    );
    setDraft((current) => ({
      title:
        !sameIssue || current.title === previousDraft?.title
          ? nextDraft.title
          : current.title,
      description:
        !sameIssue || current.description === previousDraft?.description
          ? nextDraft.description
          : current.description,
      status:
        !sameIssue || current.status === previousDraft?.status
          ? nextDraft.status
          : current.status,
      priority:
        !sameIssue || current.priority === previousDraft?.priority
          ? nextDraft.priority
          : current.priority,
      parentId:
        !sameIssue || current.parentId === previousDraft?.parentId
          ? nextDraft.parentId
          : current.parentId,
      dueDate:
        !sameIssue || current.dueDate === previousDraft?.dueDate
          ? nextDraft.dueDate
          : current.dueDate,
      tags:
        !sameIssue || equalTags(current.tags, previousDraft?.tags ?? [])
          ? nextDraft.tags
          : current.tags,
      assigneeTarget:
        !sameIssue || current.assigneeTarget === previousDraft?.assigneeTarget
          ? nextDraft.assigneeTarget
          : current.assigneeTarget,
      workflow:
        !sameIssue || current.workflow === previousDraft?.workflow
          ? nextDraft.workflow
          : current.workflow,
    }));
    syncedSourceRef.current = source;
  }, [dueDateFromSource, normalizeDescription, source]);

  const sourceDraft = source
    ? draftFromSource(source, normalizeDescription, dueDateFromSource)
    : null;
  const dirty = sourceDraft
    ? draft.title.trim() !== sourceDraft.title ||
      draft.description !== sourceDraft.description ||
      draft.status !== sourceDraft.status ||
      draft.priority !== sourceDraft.priority ||
      draft.parentId !== sourceDraft.parentId ||
      draft.dueDate !== sourceDraft.dueDate ||
      !equalTags(draft.tags, sourceDraft.tags) ||
      draft.assigneeTarget !== sourceDraft.assigneeTarget ||
      JSON.stringify(draft.workflow) !== JSON.stringify(sourceDraft.workflow)
    : false;

  const setField = useCallback(
    <K extends keyof IssueDetailDraftValue<TWorkflow>>(
      field: K,
      value: SetStateAction<IssueDetailDraftValue<TWorkflow>[K]>,
    ) => {
      setDraft((current) => ({
        ...current,
        [field]:
          typeof value === "function"
            ? (
                value as (
                  previous: IssueDetailDraftValue<TWorkflow>[K],
                ) => IssueDetailDraftValue<TWorkflow>[K]
              )(current[field])
            : value,
      }));
    },
    [],
  );

  return { draft, setDraft, setField, dirty };
}

export interface PersistIssueDetailDraftPort<TIssue> {
  update(
    issue: TIssue,
    draft: IssueDetailDraftValue,
    assignment: ReturnType<typeof parseIssueAssigneeTarget>,
  ): Promise<TIssue>;
  assign?(
    issue: TIssue,
    target: Exclude<IssueAssigneeTarget, "">,
    notifyAssignee: boolean,
  ): Promise<TIssue>;
  clearAssignment?(issue: TIssue): Promise<TIssue>;
  getAssigneeTarget(issue: TIssue): IssueAssigneeTarget;
}

export async function persistIssueDetailDraft<TIssue>(
  issue: TIssue,
  draft: IssueDetailDraftValue,
  notifyAssignee: boolean,
  port: PersistIssueDetailDraftPort<TIssue>,
): Promise<TIssue> {
  let updated = await port.update(
    issue,
    draft,
    parseIssueAssigneeTarget(draft.assigneeTarget),
  );
  if (draft.assigneeTarget === port.getAssigneeTarget(issue)) return updated;
  if (!draft.assigneeTarget) {
    return port.clearAssignment ? port.clearAssignment(updated) : updated;
  }
  return port.assign
    ? port.assign(updated, draft.assigneeTarget, notifyAssignee)
    : updated;
}
