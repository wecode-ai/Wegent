// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useState } from "react";
import { matchesBoardView, type SavedBoardView } from "./projectBoardViews";

import {
  boardPriorities,
  compareProjectBoardItems,
} from "./projectBoardSorting";
import type {
  ProjectBoardColumn,
  ProjectBoardStatePort,
} from "./ProjectBoardBody";
import {
  useProjectBoardState,
  type ProjectBoardGroupBy,
  type ProjectBoardStateOptions,
} from "./useProjectBoardState";

export interface ProjectBoardPosition {
  beforeItemId: string | null;
}

export interface StandardCloudBoardItem {
  id: string;
  parent_id: string | null;
  cloud_project_id?: string | number;
  assignee_user_id?: number | null;
  assignee_name?: string | null;
  assignee_agent_id?: string | null;
  assignee_agent_name?: string | null;
  assignee_team_id?: number | null;
  assignee_team_name?: string | null;
  priority: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  status: string;
  tags: string[];
  version?: number;
}

export interface StandardCloudBoardStatus {
  color?: string;
  id: string;
  name: string;
}

/** Apply a committed position without replacing other cards' concurrent fields. */
export function mergePersistedBoardMove<T extends StandardCloudBoardItem>(
  items: T[],
  saved: T,
  position: ProjectBoardPosition,
): T[] {
  const current = items.find((item) => item.id === saved.id);
  if (!current || (current.version ?? -1) >= (saved.version ?? 0)) return items;
  const siblings = items
    .filter(
      (item) =>
        item.id !== saved.id &&
        item.parent_id === saved.parent_id &&
        item.cloud_project_id === saved.cloud_project_id,
    )
    .map((item) => {
      // Shift global rank slots without collapsing gaps owned by invisible siblings.
      const removedRank =
        item.sort_order - (item.sort_order > current.sort_order ? 1 : 0);
      return {
        ...item,
        sort_order: removedRank + (removedRank >= saved.sort_order ? 1 : 0),
      };
    });
  siblings.push(saved);
  siblings.sort((a, b) => compareProjectBoardItems(a, b, []));
  const ranks = siblings.map((item) => item.sort_order);
  // The visible anchor also preserves intent when another move changed cached ranks.
  if (
    position.beforeItemId === null ||
    siblings.some((item) => item.id === position.beforeItemId)
  ) {
    siblings.splice(
      siblings.findIndex((item) => item.id === saved.id),
      1,
    );
    const index =
      position.beforeItemId === null
        ? siblings.length
        : siblings.findIndex((item) => item.id === position.beforeItemId);
    siblings.splice(index, 0, saved);
  }
  const positions = new Map(
    siblings.map((item, index) => [item.id, ranks[index]]),
  );
  return items.map((item) => {
    const position = positions.get(item.id);
    if (item.id === saved.id) return { ...saved, sort_order: position! };
    return position === undefined || position === item.sort_order
      ? item
      : { ...item, sort_order: position };
  });
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

function itemAssignee(
  item: StandardCloudBoardItem,
): StandardCloudBoardAssignee | null {
  if (item.assignee_user_id != null) {
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
      type: "status" as const,
      dotClass: getDotClass(groupBy, status.id, status),
      groupValue: status.id,
      key: status.id,
      label: status.name,
      status: status.id,
    }));
  }
  if (groupBy === "priority") {
    return boardPriorities.map((priority) => ({
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
        type: "tag" as const,
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
      type: "tag" as const,
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
  state: Pick<
    ProjectBoardStatePort,
    "groupBy" | "groupFilter" | "query" | "getColumnSort"
  >;
}

export function matchesStandardCloudBoardColumn<
  T extends StandardCloudBoardItem,
>(
  item: T,
  column: ProjectBoardColumn,
  groupBy: ProjectBoardGroupBy,
  extensions: Pick<StandardCloudBoardHostExtensions<T>, "noTagGroupValue">,
): boolean {
  groupBy = column.type ?? groupBy;
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
  const sortBy = state.getColumnSort(column.key);
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
    .sort((left, right) => compareProjectBoardItems(left, right, sortBy));
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
  sourceColumn: ProjectBoardColumn;
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
  sourceColumnKey,
}: {
  activeItemId: string;
  beforeItemId: string | null;
  columnDropKey: string | null;
  columns: ProjectBoardColumn[];
  extensions: Pick<StandardCloudBoardHostExtensions<T>, "noTagGroupValue">;
  groupBy: ProjectBoardGroupBy;
  items: T[];
  sourceColumnKey: string;
}): StandardCloudBoardDrop | null {
  const sourceColumn = columns.find((column) => column.key === sourceColumnKey);
  const column = columns.find((column) => column.key === columnDropKey);
  const item = items.find((item) => item.id === activeItemId);
  if (
    !sourceColumn ||
    !column ||
    !item ||
    !matchesStandardCloudBoardColumn(item, sourceColumn, groupBy, extensions)
  )
    return null;
  if (beforeItemId === activeItemId && sourceColumn.key === column.key)
    return null;
  const target = beforeItemId
    ? items.find((item) => item.id === beforeItemId)
    : null;
  if (
    beforeItemId &&
    (!target ||
      target.parent_id !== item.parent_id ||
      target.cloud_project_id !== item.cloud_project_id ||
      !matchesStandardCloudBoardColumn(target, column, groupBy, extensions))
  )
    return null;
  return {
    beforeItemId: beforeItemId === activeItemId ? null : beforeItemId,
    column,
    itemId: activeItemId,
    sourceColumn,
  };
}

export interface StandardCloudBoardControllerOptions<
  T extends StandardCloudBoardItem,
> extends ProjectBoardStateOptions {
  view?: SavedBoardView | null;
  createColumns(groupBy: ProjectBoardGroupBy): ProjectBoardColumn[];
  currentParentId?: string | null;
  supportsOrder?: boolean;
  extensions: StandardCloudBoardHostExtensions<T>;
  items: T[];
  onCurrentParentIdChange?(parentId: string | null): void;
  onMove(
    item: T,
    column: ProjectBoardColumn,
    beforeItemId: string | null,
    mutation: StandardCloudBoardMutation<T>,
  ): Promise<void | boolean> | void;
}

export type StandardCloudBoardMutation<T extends StandardCloudBoardItem> = (
  | {
      kind: "status";
      optimisticItems: T[];
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
    }
  | { kind: "reorder"; optimisticItems: T[] }
) & { position?: ProjectBoardPosition };

export interface StandardCloudBoardMutationUpdate {
  position?: ProjectBoardPosition;
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
      position?: ProjectBoardPosition;
    },
  ): Promise<T>;
  refreshOrder?(item: T): Promise<void>;
  update(item: T, input: TUpdate): Promise<T>;
}

export function standardCloudBoardMutationUpdate<
  T extends StandardCloudBoardItem,
>(mutation: StandardCloudBoardMutation<T>): StandardCloudBoardMutationUpdate {
  if (mutation.kind === "reorder") return {};
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
  const position = mutation.position;
  if (position && !commands.refreshOrder)
    throw new Error("Board moves require persisted-order refresh");
  const updated =
    mutation.kind === "assignee" &&
    mutation.assigneeType &&
    mutation.assigneeId &&
    commands.assign
      ? await commands.assign(item, {
          assigneeId: mutation.assigneeId,
          assigneeType: mutation.assigneeType,
          notifyAssignee,
          ...(position ? { position } : {}),
        })
      : await commands.update(item, {
          ...additionalUpdate,
          ...standardUpdate,
          ...(position ? { position } : {}),
        } as TUpdate);
  if (position) await commands.refreshOrder!(updated);
  return updated;
}

function resolveStandardCloudBoardGroupMutation<
  T extends StandardCloudBoardItem,
>({
  column,
  groupBy,
  item,
  items,
  sourceColumn,
  extensions,
}: {
  column: ProjectBoardColumn;
  groupBy: ProjectBoardGroupBy;
  item: T;
  items: T[];
  sourceColumn: ProjectBoardColumn;
  extensions: Pick<StandardCloudBoardHostExtensions<T>, "noTagGroupValue">;
}): StandardCloudBoardMutation<T> | null {
  groupBy = column.type ?? groupBy;
  if (groupBy === "status") {
    return {
      kind: "status",
      status: column.groupValue,
      optimisticItems: items.map((candidate) =>
        candidate.id === item.id
          ? { ...candidate, status: column.groupValue }
          : candidate,
      ),
    };
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
  const sourceType = sourceColumn.type ?? groupBy;
  const tags =
    column.groupValue === (extensions.noTagGroupValue ?? "")
      ? []
      : [
          ...new Set([
            ...item.tags.filter(
              (tag) => sourceType !== "tag" || tag !== sourceColumn.groupValue,
            ),
            column.groupValue,
          ]),
        ];
  return {
    kind: "tag",
    optimisticItems: items.map((candidate) =>
      candidate.id === item.id ? { ...candidate, tags } : candidate,
    ),
    tags,
  };
}

export function resolveStandardCloudBoardMutation<
  T extends StandardCloudBoardItem,
>({
  manualSort = false,
  supportsOrder = true,
  extensions = {},
  ...input
}: {
  beforeItemId: string | null;
  column: ProjectBoardColumn;
  groupBy: ProjectBoardGroupBy;
  item: T;
  items: T[];
  sourceColumn: ProjectBoardColumn;
  manualSort?: boolean;
  supportsOrder?: boolean;
  extensions?: Pick<StandardCloudBoardHostExtensions<T>, "noTagGroupValue">;
}): StandardCloudBoardMutation<T> | null {
  if (
    !matchesStandardCloudBoardColumn(
      input.item,
      input.sourceColumn,
      input.groupBy,
      extensions,
    )
  )
    return null;
  const sameColumn = input.sourceColumn.key === input.column.key;
  if (
    (input.sourceColumn.type ?? input.groupBy) !==
      (input.column.type ?? input.groupBy) &&
    matchesStandardCloudBoardColumn(
      input.item,
      input.column,
      input.groupBy,
      extensions,
    )
  )
    return null;
  if (sameColumn && !supportsOrder) return null;
  const mutation: StandardCloudBoardMutation<T> | null = sameColumn
    ? manualSort
      ? { kind: "reorder", optimisticItems: input.items }
      : null
    : resolveStandardCloudBoardGroupMutation({ ...input, extensions });
  if (!mutation || !supportsOrder) return mutation;

  // One canonical sibling order spans statuses and is projected into every grouping.
  // Unrelated siblings keep their relative order, including cards hidden by filters.
  const siblings = mutation.optimisticItems
    .filter(
      (candidate) =>
        candidate.parent_id === input.item.parent_id &&
        candidate.cloud_project_id === input.item.cloud_project_id,
    )
    .sort((a, b) => compareProjectBoardItems(a, b, []));
  const remaining = siblings.filter(
    (candidate) => candidate.id !== input.item.id,
  );
  const lane = remaining.filter((candidate) =>
    matchesStandardCloudBoardColumn(
      candidate,
      input.column,
      input.groupBy,
      extensions,
    ),
  );
  const beforeItemId = manualSort ? input.beforeItemId : null;
  if (beforeItemId && !lane.some((candidate) => candidate.id === beforeItemId))
    return null;
  const insertion = beforeItemId
    ? remaining.findIndex((candidate) => candidate.id === beforeItemId)
    : lane.length
      ? remaining.findIndex((candidate) => candidate.id === lane.at(-1)!.id) + 1
      : remaining.length;
  const moved = siblings.find((candidate) => candidate.id === input.item.id)!;
  remaining.splice(insertion, 0, moved);
  if (
    sameColumn &&
    remaining.every((candidate, index) => candidate.id === siblings[index].id)
  )
    return null;
  const positions = new Map(
    remaining.map((candidate, index) => [candidate.id, index]),
  );
  return {
    ...mutation,
    position: { beforeItemId: remaining[insertion + 1]?.id ?? null },
    optimisticItems: mutation.optimisticItems.map((candidate) =>
      positions.has(candidate.id)
        ? { ...candidate, sort_order: positions.get(candidate.id)! }
        : candidate,
    ),
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
  onMove,
  supportsOrder = true,
  view,
  ...stateOptions
}: StandardCloudBoardControllerOptions<T>) {
  const boardState = useProjectBoardState(stateOptions);
  const [activeDragItemId, setActiveDragItemId] = useState<string | null>(null);
  const [activeSourceColumnKey, setActiveSourceColumnKey] = useState<
    string | null
  >(null);
  const [lastMove, setLastMove] = useState<{
    itemId: string;
    columnKey: string;
    scope?: string;
  } | null>(null);
  const [moveError, setMoveError] = useState<{
    message: string;
    scope?: string;
  } | null>(null);
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

  const moveItem = useCallback(
    (
      itemId: string,
      column: ProjectBoardColumn,
      beforeItemId: string | null,
      sourceColumn: ProjectBoardColumn,
    ) => {
      const item = items.find((candidate) => candidate.id === itemId);
      if (!item) return;
      const manualSort = boardState.getColumnSort(column.key).length === 0;
      const targetBeforeItemId = manualSort ? beforeItemId : null;
      const mutation = resolveStandardCloudBoardMutation({
        beforeItemId: targetBeforeItemId,
        column,
        groupBy: boardState.groupBy,
        item,
        items,
        manualSort,
        supportsOrder,
        extensions,
        sourceColumn,
      });
      if (mutation) {
        setLastMove(null);
        setMoveError(null);
        void Promise.resolve(onMove(item, column, targetBeforeItemId, mutation))
          .then((result) => {
            if (result !== false)
              setLastMove({
                itemId,
                columnKey: column.key,
                scope: stateOptions.viewScope,
              });
          })
          .catch((cause) =>
            setMoveError({
              message: cause instanceof Error ? cause.message : String(cause),
              scope: stateOptions.viewScope,
            }),
          );
      }
    },
    [
      boardState.groupBy,
      boardState.getColumnSort,
      extensions,
      items,
      onMove,
      supportsOrder,
      stateOptions.viewScope,
    ],
  );

  const moveDroppedItem = useCallback(
    ({
      activeItemId,
      beforeItemId,
      columnDropKey,
      sourceColumnKey,
      groupBy,
    }: {
      activeItemId: string | null;
      beforeItemId: string | null;
      columnDropKey: string | null;
      sourceColumnKey: string | undefined;
      groupBy: ProjectBoardGroupBy | undefined;
    }) => {
      if (!activeItemId || !sourceColumnKey || groupBy !== boardState.groupBy)
        return;
      const drop = resolveStandardCloudBoardDrop({
        activeItemId,
        beforeItemId,
        columnDropKey,
        columns,
        extensions,
        groupBy: boardState.groupBy,
        items,
        sourceColumnKey,
      });
      if (drop)
        moveItem(
          drop.itemId,
          drop.column,
          drop.beforeItemId,
          drop.sourceColumn,
        );
    },
    [boardState.groupBy, columns, extensions, items, moveItem],
  );

  const getColumnItems = useCallback(
    (column: ProjectBoardColumn, state: ProjectBoardStatePort) =>
      filterStandardCloudBoardItems({
        column,
        currentParentId,
        extensions,
        items: view
          ? items.filter((item) => matchesBoardView(item, view))
          : items,
        state,
      }),
    [currentParentId, extensions, items, view],
  );

  return {
    activeDragItemId,
    activeSourceColumnKey,
    setActiveSourceColumnKey,
    lastMove: lastMove?.scope === stateOptions.viewScope ? lastMove : null,
    moveError:
      moveError?.scope === stateOptions.viewScope
        ? (moveError?.message ?? null)
        : null,
    breadcrumb,
    columns,
    currentParent,
    currentParentId,
    getColumnItems,
    moveItem,
    moveDroppedItem,
    setActiveDragItemId,
    setCurrentParentId,
    state: boardState,
  };
}
