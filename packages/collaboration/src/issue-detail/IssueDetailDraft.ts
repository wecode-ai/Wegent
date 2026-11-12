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
  | `resource:${string}`
  | `group:${string}`
  | `team:${number}`;

export interface IssueDetailDraftSource<TWorkflow = unknown> {
  id: string;
  version: number;
  title: string;
  description: string;
  status: string;
  priority: CollaborationPriority;
  parent_id: string | null;
  start_at?: string | null;
  due_at: string | null;
  tags: string[];
  assignee_user_id?: number | null;
  assignee_agent_id?: string | null;
  assignee_team_id?: number | null;
  assignee_group_id?: string | null;
  assignee_group_source_id?: string | null;
  workflow?: TWorkflow | null;
}

export interface IssueDetailDraftValue<TWorkflow = unknown> {
  title: string;
  description: string;
  status: string;
  priority: CollaborationPriority;
  parentId: string;
  startDate: string;
  dueDate: string;
  tags: string[];
  assigneeTarget: IssueAssigneeTarget;
  assigneeGroupSourceId: string | null;
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
  /** Preserve explicit edits while serialized saves reconcile their responses. */
  preserveEditedFields?: boolean;
  startDateFromSource?: (startAt: string | null) => string;
  dueDateFromSource?: (dueAt: string | null) => string;
}

export function issueAssigneeTarget(
  source: Pick<
    IssueDetailDraftSource,
    | "assignee_user_id"
    | "assignee_agent_id"
    | "assignee_team_id"
    | "assignee_group_id"
  >,
): IssueAssigneeTarget {
  if (source.assignee_group_id) return `group:${source.assignee_group_id}`;
  if (source.assignee_team_id) return `team:${source.assignee_team_id}`;
  if (source.assignee_agent_id) return `agent:${source.assignee_agent_id}`;
  if (source.assignee_user_id != null) return `user:${source.assignee_user_id}`;
  return "";
}

export function parseIssueAssigneeTarget(target: IssueAssigneeTarget): {
  assigneeUserId: number | null;
  assigneeAgentId: string | null;
  assigneeTeamId: number | null;
  assigneeGroupId?: string;
} {
  return {
    assigneeUserId: target.startsWith("user:") ? Number(target.slice(5)) : null,
    assigneeAgentId: target.startsWith("agent:") ? target.slice(6) : null,
    assigneeTeamId: target.startsWith("team:") ? Number(target.slice(5)) : null,
    ...(target.startsWith("group:")
      ? { assigneeGroupId: target.slice(6) }
      : {}),
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
  startDateFromSource: (startAt: string | null) => string,
  dueDateFromSource: (dueAt: string | null) => string,
): IssueDetailDraftValue<TWorkflow> {
  return {
    title: source.title ?? "",
    description: normalizeDescription(source.description ?? ""),
    status: source.status ?? "",
    priority: source.priority ?? "none",
    parentId: source.parent_id ?? "",
    startDate: startDateFromSource(source.start_at ?? null),
    dueDate: dueDateFromSource(source.due_at),
    tags: source.tags ?? [],
    assigneeTarget: issueAssigneeTarget(source),
    assigneeGroupSourceId: source.assignee_group_source_id ?? null,
    workflow: source.workflow ?? null,
  };
}

export function useIssueDetailDraft<TWorkflow = unknown>({
  source,
  initial,
  normalizeDescription = identityDescription,
  preserveEditedFields,
  startDateFromSource = defaultDueDate,
  dueDateFromSource = defaultDueDate,
}: IssueDetailDraftOptions<TWorkflow>) {
  const initialValue: IssueDetailDraftValue<TWorkflow> = {
    title: initial.title,
    description: initial.description,
    status: initial.status,
    priority: initial.priority,
    parentId: initial.parentId ?? "",
    startDate: initial.startDate ?? "",
    dueDate: initial.dueDate ?? "",
    tags: initial.tags ?? [],
    assigneeTarget: initial.assigneeTarget ?? "",
    assigneeGroupSourceId: initial.assigneeGroupSourceId ?? null,
    workflow: initial.workflow ?? null,
  };
  const [draft, setDraft] = useState<IssueDetailDraftValue<TWorkflow>>(() =>
    source
      ? draftFromSource(
          source,
          normalizeDescription,
          startDateFromSource,
          dueDateFromSource,
        )
      : initialValue,
  );
  const editedFields = useRef(
    new Set<keyof IssueDetailDraftValue<TWorkflow>>(),
  );
  const wasPreservingEdits = useRef(false);
  const syncedSourceRef = useRef<IssueDetailDraftSource<TWorkflow> | null>(
    source,
  );

  useEffect(() => {
    // The final response and pending=false can arrive in the same React batch.
    const preserveEdits = preserveEditedFields || wasPreservingEdits.current;
    wasPreservingEdits.current = Boolean(preserveEditedFields);
    if (!source) return;
    const previous = syncedSourceRef.current;
    const edited = new Set(editedFields.current);
    if (!preserveEditedFields || previous?.id !== source.id)
      editedFields.current.clear();
    if (previous === source) return;

    const sameIssue = previous?.id === source.id;
    const previousDraft = previous
      ? draftFromSource(
          previous,
          normalizeDescription,
          startDateFromSource,
          dueDateFromSource,
        )
      : null;
    const nextDraft = draftFromSource(
      source,
      normalizeDescription,
      startDateFromSource,
      dueDateFromSource,
    );
    const merge = (
      field: keyof IssueDetailDraftValue<TWorkflow>,
      unchanged: boolean,
    ) => !sameIssue || ((!preserveEdits || !edited.has(field)) && unchanged);
    setDraft((current) => ({
      title: merge("title", current.title === previousDraft?.title)
        ? nextDraft.title
        : current.title,
      description: merge(
        "description",
        current.description === previousDraft?.description,
      )
        ? nextDraft.description
        : current.description,
      status: merge("status", current.status === previousDraft?.status)
        ? nextDraft.status
        : current.status,
      priority: merge("priority", current.priority === previousDraft?.priority)
        ? nextDraft.priority
        : current.priority,
      parentId: merge("parentId", current.parentId === previousDraft?.parentId)
        ? nextDraft.parentId
        : current.parentId,
      startDate: merge(
        "startDate",
        current.startDate === previousDraft?.startDate,
      )
        ? nextDraft.startDate
        : current.startDate,
      dueDate: merge("dueDate", current.dueDate === previousDraft?.dueDate)
        ? nextDraft.dueDate
        : current.dueDate,
      tags: merge("tags", equalTags(current.tags, previousDraft?.tags ?? []))
        ? nextDraft.tags
        : current.tags,
      assigneeTarget: merge(
        "assigneeTarget",
        current.assigneeTarget === previousDraft?.assigneeTarget,
      )
        ? nextDraft.assigneeTarget
        : current.assigneeTarget,
      workflow: merge("workflow", current.workflow === previousDraft?.workflow)
        ? nextDraft.workflow
        : current.workflow,
      assigneeGroupSourceId: merge(
        "assigneeGroupSourceId",
        current.assigneeGroupSourceId === previousDraft?.assigneeGroupSourceId,
      )
        ? nextDraft.assigneeGroupSourceId
        : current.assigneeGroupSourceId,
    }));
    syncedSourceRef.current = source;
  }, [
    dueDateFromSource,
    normalizeDescription,
    preserveEditedFields,
    source,
    startDateFromSource,
  ]);

  const sourceDraft = source
    ? draftFromSource(
        source,
        normalizeDescription,
        startDateFromSource,
        dueDateFromSource,
      )
    : null;
  const dirty = sourceDraft
    ? draft.title.trim() !== sourceDraft.title ||
      draft.description !== sourceDraft.description ||
      draft.status !== sourceDraft.status ||
      draft.priority !== sourceDraft.priority ||
      draft.parentId !== sourceDraft.parentId ||
      draft.startDate !== sourceDraft.startDate ||
      draft.dueDate !== sourceDraft.dueDate ||
      !equalTags(draft.tags, sourceDraft.tags) ||
      draft.assigneeTarget !== sourceDraft.assigneeTarget ||
      draft.assigneeGroupSourceId !== sourceDraft.assigneeGroupSourceId ||
      JSON.stringify(draft.workflow) !== JSON.stringify(sourceDraft.workflow)
    : false;

  const setField = useCallback(
    <K extends keyof IssueDetailDraftValue<TWorkflow>>(
      field: K,
      value: SetStateAction<IssueDetailDraftValue<TWorkflow>[K]>,
    ) => {
      if (preserveEditedFields !== undefined) editedFields.current.add(field);
      setDraft((current) => {
        const next =
          typeof value === "function"
            ? (
                value as (
                  previous: IssueDetailDraftValue<TWorkflow>[K],
                ) => IssueDetailDraftValue<TWorkflow>[K]
              )(current[field])
            : value;
        return { ...current, [field]: next };
      });
    },
    [preserveEditedFields],
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
