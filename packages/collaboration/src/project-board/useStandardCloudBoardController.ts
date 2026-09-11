// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useState } from "react";

import { reorderLaneItems } from "../board";
import type {
  ProjectBoardColumn,
  ProjectBoardStatePort,
} from "./ProjectBoardBody";
import {
  useProjectBoardState,
  type ProjectBoardGroupBy,
  type ProjectBoardStateOptions,
} from "./useProjectBoardState";

export interface StandardCloudBoardItem {
  id: string;
  parent_id: string | null;
  assignee_user_id?: number | null;
  assignee_name?: string | null;
  assignee_agent_id?: string | null;
  assignee_agent_name?: string | null;
  assignee_team_id?: number | null;
  assignee_team_name?: string | null;
  priority: string;
  sort_order: number;
  status: string;
  tags: string[];
  version?: number;
}

export interface StandardCloudBoardStatus {
  color?: string;
  id: string;
  name: string;
}

export interface StandardCloudBoardAssignee {
  id: string;
  name: string;
  type: "user" | "agent" | "team";
}

export interface StandardCloudBoardColumnLabels {
  noPriority: string;
  noTag: string;
  priority: Record<string, string>;
  unassigned: string;
}

export interface StandardCloudBoardColumnOptions<
  T extends StandardCloudBoardItem,
> {
  assignees?: StandardCloudBoardAssignee[];
  getDotClass?: (
    groupBy: ProjectBoardGroupBy,
    value: string,
    status?: StandardCloudBoardStatus,
  ) => string;
  groupBy: ProjectBoardGroupBy;
  items: T[];
  labels: StandardCloudBoardColumnLabels;
  statuses: StandardCloudBoardStatus[];
  tags?: string[];
}

const standardPriorities = ["none", "low", "medium", "high", "urgent"];

function itemAssignee(
  item: StandardCloudBoardItem,
): StandardCloudBoardAssignee | null {
  if (item.assignee_user_id) {
    return {
      id: String(item.assignee_user_id),
      name: item.assignee_name || String(item.assignee_user_id),
      type: "user",
    };
  }
  if (item.assignee_agent_id) {
    return {
      id: item.assignee_agent_id,
      name: item.assignee_agent_name || item.assignee_agent_id,
      type: "agent",
    };
  }
  if (item.assignee_team_id) {
    return {
      id: String(item.assignee_team_id),
      name: item.assignee_team_name || String(item.assignee_team_id),
      type: "team",
    };
  }
  return null;
}

export function standardCloudBoardAssigneeValue(
  assignee: Pick<StandardCloudBoardAssignee, "id" | "type">,
): string {
  return assignee.type === "user"
    ? assignee.id
    : `${assignee.type}:${assignee.id}`;
}

export function createStandardCloudBoardColumns<
  T extends StandardCloudBoardItem,
>({
  assignees = [],
  getDotClass = () => "bg-zinc-400",
  groupBy,
  items,
  labels,
  statuses,
  tags = [],
}: StandardCloudBoardColumnOptions<T>): ProjectBoardColumn[] {
  if (groupBy === "status") {
    return statuses.map((status) => ({
      dotClass: getDotClass(groupBy, status.id, status),
      groupValue: status.id,
      key: status.id,
      label: status.name,
      status: status.id,
    }));
  }
  if (groupBy === "priority") {
    return standardPriorities.map((priority) => ({
      dotClass: getDotClass(groupBy, priority),
      groupValue: priority,
      key: `priority-${priority}`,
      label:
        priority === "none"
          ? labels.noPriority
          : (labels.priority[priority] ?? priority),
      status: "",
    }));
  }
  if (groupBy === "assignee") {
    const available = new Map<string, StandardCloudBoardAssignee>();
    for (const assignee of assignees) {
      available.set(standardCloudBoardAssigneeValue(assignee), assignee);
    }
    for (const item of items) {
      const assignee = itemAssignee(item);
      if (assignee) {
        available.set(standardCloudBoardAssigneeValue(assignee), assignee);
      }
    }
    return [
      ...[...available.entries()].map(([groupValue, assignee]) => ({
        dotClass: getDotClass(groupBy, groupValue),
        groupValue,
        key: `assignee-${groupValue.replace(":", "-")}`,
        label: assignee.name,
        status: "",
      })),
      {
        dotClass: getDotClass(groupBy, ""),
        groupValue: "",
        key: "assignee-unassigned",
        label: labels.unassigned,
        status: "",
      },
    ];
  }
  const availableTags = new Set(tags);
  for (const item of items) {
    for (const tag of item.tags) availableTags.add(tag);
  }
  return [
    ...[...availableTags]
      .sort((left, right) => left.localeCompare(right))
      .map((tag) => ({
        dotClass: getDotClass(groupBy, tag),
        groupValue: tag,
        key: `tag-${tag}`,
        label: tag,
        status: "",
      })),
    {
      dotClass: getDotClass(groupBy, ""),
      groupValue: "",
      key: "tag-untagged",
      label: labels.noTag,
      status: "",
    },
  ];
}

export interface StandardCloudBoardHostExtensions<
  T extends StandardCloudBoardItem,
> {
  getSearchText(item: T): string;
  noTagGroupValue?: string;
}

export interface StandardCloudBoardFilterInput<
  T extends StandardCloudBoardItem,
> {
  column: ProjectBoardColumn;
  currentParentId: string | null;
  extensions: StandardCloudBoardHostExtensions<T>;
  items: T[];
  state: Pick<ProjectBoardStatePort, "groupBy" | "groupFilter" | "query">;
}

export function matchesStandardCloudBoardColumn<
  T extends StandardCloudBoardItem,
>(
  item: T,
  column: ProjectBoardColumn,
  groupBy: ProjectBoardGroupBy,
  extensions: Pick<StandardCloudBoardHostExtensions<T>, "noTagGroupValue">,
): boolean {
  if (groupBy === "status") return item.status === column.groupValue;
  if (groupBy === "priority") return item.priority === column.groupValue;
  if (groupBy === "assignee") {
    const assignee = itemAssignee(item);
    return assignee
      ? standardCloudBoardAssigneeValue(assignee) === column.groupValue
      : column.groupValue === "";
  }
  const noTagGroupValue = extensions.noTagGroupValue ?? "";
  return column.groupValue === noTagGroupValue
    ? item.tags.length === 0
    : item.tags.includes(column.groupValue);
}

export function filterStandardCloudBoardItems<
  T extends StandardCloudBoardItem,
>({
  column,
  currentParentId,
  extensions,
  items,
  state,
}: StandardCloudBoardFilterInput<T>): T[] {
  const query = state.query.trim().toLocaleLowerCase();
  return items
    .filter(
      (item) =>
        item.parent_id === currentParentId &&
        matchesStandardCloudBoardColumn(
          item,
          column,
          state.groupBy,
          extensions,
        ) &&
        (!state.groupFilter || column.key === state.groupFilter) &&
        (!query ||
          extensions.getSearchText(item).toLocaleLowerCase().includes(query)),
    )
    .sort((left, right) => left.sort_order - right.sort_order);
}

export function buildStandardCloudBoardBreadcrumb<
  T extends StandardCloudBoardItem,
>(items: T[], currentParentId: string | null): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const path: T[] = [];
  const visited = new Set<string>();
  let current = currentParentId ? byId.get(currentParentId) : undefined;
  while (current && !visited.has(current.id)) {
    path.unshift(current);
    visited.add(current.id);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return path;
}

export interface StandardCloudBoardDrop {
  beforeItemId: string | null;
  column: ProjectBoardColumn;
  itemId: string;
}

export function resolveStandardCloudBoardDrop<
  T extends StandardCloudBoardItem,
>({
  activeItemId,
  beforeItemId,
  columnDropKey,
  columns,
  extensions,
  groupBy,
  items,
}: {
  activeItemId: string;
  beforeItemId: string | null;
  columnDropKey: string | null;
  columns: ProjectBoardColumn[];
  extensions: Pick<StandardCloudBoardHostExtensions<T>, "noTagGroupValue">;
  groupBy: ProjectBoardGroupBy;
  items: T[];
}): StandardCloudBoardDrop | null {
  if (beforeItemId) {
    if (beforeItemId === activeItemId) return null;
    const target = items.find((item) => item.id === beforeItemId);
    const column = target
      ? columns.find((candidate) =>
          matchesStandardCloudBoardColumn(
            target,
            candidate,
            groupBy,
            extensions,
          ),
        )
      : undefined;
    return column ? { beforeItemId, column, itemId: activeItemId } : null;
  }
  const column = columnDropKey
    ? columns.find((candidate) => candidate.key === columnDropKey)
    : undefined;
  return column ? { beforeItemId: null, column, itemId: activeItemId } : null;
}

export interface StandardCloudBoardControllerOptions<
  T extends StandardCloudBoardItem,
> extends ProjectBoardStateOptions {
  createColumns(groupBy: ProjectBoardGroupBy): ProjectBoardColumn[];
  currentParentId?: string | null;
  extensions: StandardCloudBoardHostExtensions<T>;
  items: T[];
  onCurrentParentIdChange?(parentId: string | null): void;
  onGroupByChange?(groupBy: ProjectBoardGroupBy): Promise<void> | void;
  onMove(
    item: T,
    column: ProjectBoardColumn,
    beforeItemId: string | null,
    mutation: StandardCloudBoardMutation<T>,
  ): Promise<void> | void;
}

export type StandardCloudBoardMutation<T extends StandardCloudBoardItem> =
  | {
      kind: "status";
      optimisticItems: T[];
      laneIds: string[];
      status: string;
    }
  | {
      kind: "priority";
      optimisticItems: T[];
      priority: string;
    }
  | {
      kind: "assignee";
      assigneeId: string | null;
      assigneeType: "user" | "agent" | "team" | null;
      optimisticItems: T[];
    }
  | {
      kind: "tag";
      optimisticItems: T[];
      tags: string[];
    };

export interface StandardCloudBoardMutationUpdate {
  assignee_agent_id?: string | null;
  assignee_team_id?: number | null;
  assignee_user_id?: number | null;
  priority?: string;
  status?: string;
  tags?: string[];
}

export interface StandardCloudBoardMutationCommands<
  T extends StandardCloudBoardItem,
  TUpdate extends StandardCloudBoardMutationUpdate,
> {
  assign?(
    item: T,
    input: {
      assigneeId: string;
      assigneeType: "user" | "agent" | "team";
      notifyAssignee: boolean;
    },
  ): Promise<T>;
  reorder?(
    item: T,
    input: {
      laneIds: string[];
      optimisticItems: T[];
      status: string;
    },
  ): Promise<void>;
  update(item: T, input: TUpdate): Promise<T>;
}

export function standardCloudBoardMutationUpdate<
  T extends StandardCloudBoardItem,
>(mutation: StandardCloudBoardMutation<T>): StandardCloudBoardMutationUpdate {
  if (mutation.kind === "status") return { status: mutation.status };
  if (mutation.kind === "priority") return { priority: mutation.priority };
  if (mutation.kind === "assignee") {
    return {
      assignee_user_id:
        mutation.assigneeType === "user" ? Number(mutation.assigneeId) : null,
      assignee_agent_id:
        mutation.assigneeType === "agent" ? mutation.assigneeId : null,
      assignee_team_id:
        mutation.assigneeType === "team" ? Number(mutation.assigneeId) : null,
    };
  }
  return { tags: mutation.tags };
}

export async function executeStandardCloudBoardMutation<
  T extends StandardCloudBoardItem,
  TUpdate extends StandardCloudBoardMutationUpdate,
>({
  additionalUpdate,
  commands,
  item,
  mutation,
  notifyAssignee = true,
}: {
  additionalUpdate?: Omit<TUpdate, keyof StandardCloudBoardMutationUpdate>;
  commands: StandardCloudBoardMutationCommands<T, TUpdate>;
  item: T;
  mutation: StandardCloudBoardMutation<T>;
  notifyAssignee?: boolean;
}): Promise<T> {
  const standardUpdate = standardCloudBoardMutationUpdate(mutation);
  const updated =
    mutation.kind === "assignee" &&
    mutation.assigneeType &&
    mutation.assigneeId &&
    commands.assign
      ? await commands.assign(item, {
          assigneeId: mutation.assigneeId,
          assigneeType: mutation.assigneeType,
          notifyAssignee,
        })
      : await commands.update(item, {
          ...additionalUpdate,
          ...standardUpdate,
        } as TUpdate);

  if (mutation.kind === "status" && commands.reorder) {
    const optimisticItems = mutation.optimisticItems.map((candidate) =>
      candidate.id === updated.id
        ? {
            ...candidate,
            ...updated,
            sort_order: candidate.sort_order,
          }
        : candidate,
    );
    await commands.reorder(updated, {
      laneIds: mutation.laneIds,
      optimisticItems,
      status: mutation.status,
    });
  }
  return updated;
}

export function resolveStandardCloudBoardMutation<
  T extends StandardCloudBoardItem,
>({
  beforeItemId,
  column,
  groupBy,
  item,
  items,
}: {
  beforeItemId: string | null;
  column: ProjectBoardColumn;
  groupBy: ProjectBoardGroupBy;
  item: T;
  items: T[];
}): StandardCloudBoardMutation<T> | null {
  if (groupBy === "status") {
    const reordered = reorderLaneItems(
      items,
      item.id,
      column.groupValue,
      beforeItemId,
    );
    return reordered
      ? {
          kind: "status",
          optimisticItems: reordered.items,
          laneIds: reordered.laneIds,
          status: column.groupValue,
        }
      : null;
  }
  if (groupBy === "priority") {
    return {
      kind: "priority",
      optimisticItems: items.map((candidate) =>
        candidate.id === item.id
          ? { ...candidate, priority: column.groupValue }
          : candidate,
      ),
      priority: column.groupValue,
    };
  }
  if (groupBy === "assignee") {
    const [type, id] = column.groupValue.includes(":")
      ? column.groupValue.split(":", 2)
      : ["user", column.groupValue];
    const assigneeType =
      id && (type === "user" || type === "agent" || type === "team")
        ? type
        : null;
    const assigneeId = assigneeType ? id : null;
    return {
      kind: "assignee",
      assigneeId,
      assigneeType,
      optimisticItems: items.map((candidate) =>
        candidate.id === item.id
          ? {
              ...candidate,
              assignee_user_id:
                assigneeType === "user" ? Number(assigneeId) : null,
              assignee_agent_id: assigneeType === "agent" ? assigneeId : null,
              assignee_team_id:
                assigneeType === "team" ? Number(assigneeId) : null,
            }
          : candidate,
      ),
    };
  }
  const tags = column.groupValue ? [column.groupValue] : [];
  return {
    kind: "tag",
    optimisticItems: items.map((candidate) =>
      candidate.id === item.id ? { ...candidate, tags } : candidate,
    ),
    tags,
  };
}

export function useStandardCloudBoardController<
  T extends StandardCloudBoardItem,
>({
  createColumns,
  currentParentId: controlledCurrentParentId,
  extensions,
  items,
  onCurrentParentIdChange,
  onGroupByChange,
  onMove,
  ...stateOptions
}: StandardCloudBoardControllerOptions<T>) {
  const boardState = useProjectBoardState(stateOptions);
  const [activeDragItemId, setActiveDragItemId] = useState<string | null>(null);
  const [uncontrolledCurrentParentId, setUncontrolledCurrentParentId] =
    useState<string | null>(null);
  const currentParentId =
    controlledCurrentParentId === undefined
      ? uncontrolledCurrentParentId
      : controlledCurrentParentId;
  const setCurrentParentId = useCallback(
    (parentId: string | null) => {
      if (controlledCurrentParentId === undefined) {
        setUncontrolledCurrentParentId(parentId);
      }
      onCurrentParentIdChange?.(parentId);
    },
    [controlledCurrentParentId, onCurrentParentIdChange],
  );
  const columns = useMemo(
    () => createColumns(boardState.groupBy),
    [boardState.groupBy, createColumns],
  );
  const currentParent =
    items.find((item) => item.id === currentParentId) ?? null;
  const breadcrumb = useMemo(
    () => buildStandardCloudBoardBreadcrumb(items, currentParentId),
    [currentParentId, items],
  );

  const selectGroupBy = useCallback(
    (groupBy: ProjectBoardGroupBy) => {
      boardState.selectGroupBy(groupBy);
      void onGroupByChange?.(groupBy);
    },
    [boardState, onGroupByChange],
  );

  const moveItem = useCallback(
    (
      itemId: string,
      column: ProjectBoardColumn,
      beforeItemId: string | null,
    ) => {
      const item = items.find((candidate) => candidate.id === itemId);
      if (!item) return;
      const mutation = resolveStandardCloudBoardMutation({
        beforeItemId,
        column,
        groupBy: boardState.groupBy,
        item,
        items,
      });
      if (mutation) void onMove(item, column, beforeItemId, mutation);
    },
    [boardState.groupBy, items, onMove],
  );

  const moveDroppedItem = useCallback(
    ({
      activeItemId,
      beforeItemId,
      columnDropKey,
    }: {
      activeItemId: string;
      beforeItemId: string | null;
      columnDropKey: string | null;
    }) => {
      const drop = resolveStandardCloudBoardDrop({
        activeItemId,
        beforeItemId,
        columnDropKey,
        columns,
        extensions,
        groupBy: boardState.groupBy,
        items,
      });
      if (drop) moveItem(drop.itemId, drop.column, drop.beforeItemId);
    },
    [boardState.groupBy, columns, extensions, items, moveItem],
  );

  const getColumnItems = useCallback(
    (column: ProjectBoardColumn, state: ProjectBoardStatePort) =>
      filterStandardCloudBoardItems({
        column,
        currentParentId,
        extensions,
        items,
        state,
      }),
    [currentParentId, extensions, items],
  );

  return {
    activeDragItemId,
    breadcrumb,
    columns,
    currentParent,
    currentParentId,
    getColumnItems,
    moveItem,
    moveDroppedItem,
    setActiveDragItemId,
    setCurrentParentId,
    state: {
      ...boardState,
      selectGroupBy,
    },
  };
}
