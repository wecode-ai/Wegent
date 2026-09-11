// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  CollaborationIssueCard,
  type CollaborationIssueCardLabels,
} from "../issue-card";
import {
  createStandardCloudBoardColumns,
  ProjectBoardBody,
  useStandardCloudBoardController,
  type ProjectBoardColumn,
  type ProjectBoardGroupBy,
  type StandardCloudBoardMutation,
} from "../project-board";
import { canEditCollaborationIssue } from "../permissions";
import { collaborationTestIds } from "../testIds";
import type {
  CollaborationIssue,
  CollaborationAgent,
  CollaborationMember,
  CollaborationProject,
  CollaborationStatus,
} from "../types";

const statusDotClasses: Record<CollaborationStatus["color"], string> = {
  gray: "bg-zinc-400",
  blue: "bg-blue-500",
  orange: "bg-amber-500",
  purple: "bg-violet-500",
  green: "bg-emerald-500",
  red: "bg-red-500",
};

interface NativeDropContextValue {
  onDrop(dropId: string, itemId: string): void;
}

const NativeDropContext = createContext<NativeDropContextValue | null>(null);

function NativeDndContext({
  children,
  onNativeDrop,
}: {
  children?: ReactNode;
  onNativeDrop?: (dropId: string, itemId: string) => void;
}) {
  const value = useMemo<NativeDropContextValue>(
    () => ({
      onDrop: (dropId, itemId) => onNativeDrop?.(dropId, itemId),
    }),
    [onNativeDrop],
  );
  return (
    <NativeDropContext.Provider value={value}>
      {children}
    </NativeDropContext.Provider>
  );
}

function NativeDragOverlay() {
  return null;
}

function useNativeDroppable({ id }: { id: string }) {
  const context = useContext(NativeDropContext);
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [isOver, setIsOver] = useState(false);

  useEffect(() => {
    if (!node) return;
    const dragOver = (event: globalThis.DragEvent) => {
      event.preventDefault();
      setIsOver(true);
    };
    const dragLeave = () => setIsOver(false);
    const drop = (event: globalThis.DragEvent) => {
      event.preventDefault();
      setIsOver(false);
      const itemId = event.dataTransfer?.getData("text/plain");
      if (itemId) context?.onDrop(id, itemId);
    };
    node.addEventListener("dragover", dragOver);
    node.addEventListener("dragleave", dragLeave);
    node.addEventListener("drop", drop);
    return () => {
      node.removeEventListener("dragover", dragOver);
      node.removeEventListener("dragleave", dragLeave);
      node.removeEventListener("drop", drop);
    };
  }, [context, id, node]);

  return { isOver, setNodeRef: setNode };
}

const nativeDnd = {
  DndContext: NativeDndContext,
  DragOverlay: NativeDragOverlay,
  useDroppable: useNativeDroppable,
};

export interface ProjectBoardAdapterLabels {
  groupAssignee: string;
  groupBy: string;
  groupPriority: string;
  groupStatus: string;
  groupTag: string;
  noIssues: string;
  noTag: string;
  search: string;
  unassigned: string;
}

interface ProjectBoardAdapterProps {
  boardError: string | null;
  agents: CollaborationAgent[];
  issues: CollaborationIssue[];
  labels: ProjectBoardAdapterLabels;
  members: CollaborationMember[];
  project: CollaborationProject;
  statuses: CollaborationStatus[];
  onCreateIssue(): void;
  onGroupByChange(groupBy: ProjectBoardGroupBy): Promise<void>;
  onOpen(issue: CollaborationIssue): void;
  onMove(
    issue: CollaborationIssue,
    mutation: StandardCloudBoardMutation<CollaborationIssue>,
  ): Promise<void>;
}

function issueSearchText(
  project: CollaborationProject,
  issue: CollaborationIssue,
): string {
  return [
    `${project.project_key}-${issue.sequence_number}`,
    issue.title,
    issue.description,
    issue.assignee_name,
    issue.assignee_agent_name,
    issue.assignee_team_name,
    ...issue.tags,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

export function ProjectBoardAdapter({
  agents,
  boardError,
  issues,
  labels,
  members,
  onCreateIssue,
  onGroupByChange,
  onMove,
  onOpen,
  project,
  statuses,
}: ProjectBoardAdapterProps) {
  const createColumns = useCallback(
    (groupBy: ProjectBoardGroupBy): ProjectBoardColumn[] =>
      createStandardCloudBoardColumns({
        assignees: [
          ...members.map((member) => ({
            id: String(member.user_id),
            name: member.user_name,
            type: "user" as const,
          })),
          ...agents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            type: "agent" as const,
          })),
        ],
        getDotClass: (field, value, status) =>
          field === "status"
            ? statusDotClasses[
                (status?.color as CollaborationStatus["color"]) ?? "gray"
              ]
            : field === "priority" && value === "urgent"
              ? "bg-red-500"
              : field === "priority" && value === "high"
                ? "bg-orange-500"
                : "bg-zinc-400",
        groupBy,
        statuses,
        items: issues,
        labels: {
          noPriority: "none",
          noTag: labels.noTag,
          priority: {
            low: "low",
            medium: "medium",
            high: "high",
            urgent: "urgent",
          },
          unassigned: labels.unassigned,
        },
        tags: project.tags,
      }),
    [
      agents,
      issues,
      labels.noTag,
      labels.unassigned,
      members,
      project.tags,
      statuses,
    ],
  );
  const extensions = useMemo(
    () => ({
      getSearchText: (issue: CollaborationIssue) =>
        issueSearchText(project, issue),
      noTagGroupValue: "",
    }),
    [project],
  );
  const controller = useStandardCloudBoardController({
    createColumns,
    defaultGroupBy: project.board_config?.group_by ?? "status",
    extensions,
    focusStorageKey: `collaboration-board-focus:${project.id}`,
    items: issues,
    onGroupByChange,
    onMove: (issue, _column, _beforeItemId, mutation) =>
      onMove(issue, mutation),
    personalGroupStorageKey: null,
  });
  const display = project.card_display ?? {
    show_assignee: true,
    show_priority: true,
    show_tags: true,
    show_date: true,
  };
  const cardLabels: CollaborationIssueCardLabels = {
    assignee: labels.groupAssignee,
    priority: {
      none: "none",
      low: "low",
      medium: "medium",
      high: "high",
      urgent: "urgent",
    },
    unassigned: labels.unassigned,
  };

  return (
    <div data-testid={collaborationTestIds.board} className="min-h-0 flex-1">
      <ProjectBoardBody<CollaborationIssue>
        state={controller.state}
        activeDragItemId={controller.activeDragItemId}
        boardError={boardError}
        boardItemsLoading={false}
        breadcrumb={controller.breadcrumb}
        columns={controller.columns}
        currentParent={controller.currentParent}
        currentParentId={controller.currentParentId}
        dnd={nativeDnd}
        dndContextProps={{
          onNativeDrop: (dropId: string, itemId: string) => {
            controller.setActiveDragItemId(null);
            const column = controller.columns.find(
              (candidate) =>
                candidate.key === dropId.replace("todo-column:", ""),
            );
            if (column) controller.moveItem(itemId, column, null);
          },
        }}
        externalGroupLabel=""
        externalGroupValues={[]}
        externalManagedLabel=""
        externalSearchPlaceholder=""
        focusLabels={{
          enter: "展开进行中与待确认列",
          exit: "退出执行阶段专注视图",
          title: "专注视图",
        }}
        getColumnDragHint={(column) =>
          controller.activeDragItemId ? `移到这里：${column.label}` : undefined
        }
        getColumnEmptyState={(column) => ({
          hint: labels.noIssues,
          ...(controller.state.groupBy === "status" &&
          (column.status === "inbox" || column.status === "pending")
            ? {
                action: {
                  ariaLabel: `在${column.label}中新建 Issue`,
                  label: "创建第一个 Issue",
                  onClick: onCreateIssue,
                },
              }
            : {}),
        })}
        getColumnItems={controller.getColumnItems}
        getItemKey={(issue) => issue.id}
        groupFields={[
          { id: "status", name: labels.groupStatus },
          { id: "priority", name: labels.groupPriority },
          { id: "assignee", name: labels.groupAssignee },
          { id: "tag", name: labels.groupTag },
        ]}
        isExternalBoard={false}
        isMyTasksBoard={false}
        layerCount={
          issues.filter(
            (issue) => issue.parent_id === controller.currentParentId,
          ).length
        }
        onBreadcrumbSelect={controller.setCurrentParentId}
        onSaveGlobalGroupBy={() => undefined}
        renderAddIcon={() => <span aria-hidden="true">＋</span>}
        renderChevronDown={(className) => (
          <span aria-hidden="true" className={className}>
            ▾
          </span>
        )}
        renderChevronRight={(className) => (
          <span aria-hidden="true" className={className}>
            ›
          </span>
        )}
        renderDragOverlay={() => null}
        renderExternalGroupPicker={() => null}
        renderFocusIcon={(focused) => (
          <span aria-hidden="true">{focused ? "−" : "＋"}</span>
        )}
        renderGroupPicker={(value, onChange) => (
          <label className="relative inline-flex h-8 shrink-0 cursor-pointer items-center rounded-lg border border-border bg-background px-3 text-xs text-text-secondary hover:bg-muted">
            <span>
              {labels.groupBy}：
              {value === "status"
                ? labels.groupStatus
                : value === "priority"
                  ? labels.groupPriority
                  : value === "assignee"
                    ? labels.groupAssignee
                    : labels.groupTag}
            </span>
            <span aria-hidden="true" className="ml-2">
              ▾
            </span>
            <select
              data-testid="cloud-board-group-by"
              aria-label={labels.groupBy}
              value={value}
              onChange={(event) =>
                onChange(event.target.value as ProjectBoardGroupBy)
              }
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              <option value="status">{labels.groupStatus}</option>
              <option value="priority">{labels.groupPriority}</option>
              <option value="assignee">{labels.groupAssignee}</option>
              <option value="tag">{labels.groupTag}</option>
            </select>
          </label>
        )}
        renderItem={(issue, column) => (
          <CollaborationIssueCard
            item={issue}
            reference={`${project.project_key}-${issue.sequence_number}`}
            labels={cardLabels}
            display={{
              showAssignee: display.show_assignee,
              showDate: display.show_date,
              showPriority: display.show_priority,
              showTags: display.show_tags,
            }}
            articleTestId={collaborationTestIds.issue(issue.id)}
            articleProps={{
              draggable: canEditCollaborationIssue(issue),
              onDragStart: (event) => {
                if (!canEditCollaborationIssue(issue)) {
                  event.preventDefault();
                  return;
                }
                controller.setActiveDragItemId(issue.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", issue.id);
              },
              onDragEnd: () => controller.setActiveDragItemId(null),
              onDragOver: (event) => {
                event.preventDefault();
              },
              onDrop: (event) => {
                event.preventDefault();
                event.stopPropagation();
                const itemId = event.dataTransfer.getData("text/plain");
                controller.setActiveDragItemId(null);
                const movingIssue = issues.find((item) => item.id === itemId);
                if (movingIssue && canEditCollaborationIssue(movingIssue)) {
                  controller.moveItem(itemId, column, issue.id);
                }
              },
            }}
            detailButtonProps={{ onClick: () => onOpen(issue) }}
            childrenAction={
              issues.some((candidate) => candidate.parent_id === issue.id) ? (
                <button
                  type="button"
                  data-testid={`collaboration-issue-children-${issue.id}`}
                  onClick={() => controller.setCurrentParentId(issue.id)}
                  className="mx-3 mb-3 text-xs text-text-secondary hover:text-text-primary"
                >
                  查看子任务
                </button>
              ) : null
            }
          />
        )}
        renderSearchIcon={() => <span aria-hidden="true">⌕</span>}
        renderSkeleton={() => null}
        renderTooltip={(_label, child) => child}
        rootLabel="Issue"
        rootUnitLabel="个 Issue"
        saveGlobalDisabled
        saveGlobalLabel=""
        searchPlaceholder={labels.search}
        showQuickStart={false}
        showSaveGlobal={false}
      />
    </div>
  );
}
