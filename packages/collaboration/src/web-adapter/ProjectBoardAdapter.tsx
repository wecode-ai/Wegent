import { IssueCardMilestone } from "../issue-card/IssueCardMilestone";
import type { Milestone } from "../milestones/types";
import { unmatchedCreateDefaults } from "../project-board/projectBoardViews";
import {
  projectBoardDnd,
  projectBoardCollisionDetection,
  projectBoardDrop,
  projectBoardDragItemId,
  useProjectBoardSensors,
} from "../project-board/projectBoardDnd";
import { ProjectBoardDragOverlay } from "../project-board/ProjectBoardDragOverlay";
import {
  IssueChildrenProgress,
  collectIssueChildrenProgress,
} from "../project-board/IssueChildrenProgress";
import { BrowserIssueBoardCard } from "../issue-card/BrowserIssueBoardCard";
import { useBrowserBoardRuntimeWork } from "./useBrowserBoardRuntimeWork";
import type { SharedWorkspaceRuntimeApi } from "../ports/SharedWorkspaceApi";
import type { CollaborationTranslate } from "../i18n";
import { runnerEnvironmentError } from "../execution-environment/runnerEnvironmentError";
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { findRuntimeTask } from "@wegent/chat-core/runtime-task-lookup";
import { issueNeedsUser } from "../issueParticipation";

import {
  IssueBoardCard,
  IssueBoardCardContent,
  createIssueBoardCardLabels,
} from "../issue-card";
import {
  createStandardCloudBoardColumns,
  createProjectBoardSortLabels,
  ProjectBoardBody,
  isExecutionBoardColumn,
  ProjectBoardGroupPicker,
  useStandardCloudBoardController,
  useBoardTagFilter,
  useParentIssueBoard,
  useSavedBoardViews,
  savedBoardColumns,
  BoardViewNavigation,
  BoardViewNotice,
  collectProjectTags,
  boardDropHint,
  type ProjectBoardViews,
  type ProjectBoardColumn,
  type ProjectBoardGroupBy,
  type StandardCloudBoardMutation,
} from "../project-board";
import type { WorkspaceTaskBinding } from "../ports/SharedWorkspaceApi";
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

export interface ProjectBoardAdapterLabels {
  groupAssignee: string;
  groupBy: string;
  groupPriority: string;
  groupStatus: string;
  groupTag: string;
  noIssues: string;
  noPriority: string;
  noTag: string;
  search: string;
  unassigned: string;
}

export interface ProjectBoardIssueCardRenderContext {
  column: ProjectBoardColumn;
  defaultCard: ReactNode;
  metadata?: ReactNode;
  childrenAction?: ReactNode;
  display: {
    showAssignee: boolean;
    showDate: boolean;
    showPriority: boolean;
    showTags: boolean;
  };
  focused: boolean;
  issue: CollaborationIssue;
  onOpen(): void;
  /** Present only when the host enabled Issue deletion for this board. */
  onDelete?(): void;
  previewDisabled: boolean;
  taskBindings: WorkspaceTaskBinding[];
}

export type ProjectBoardIssueCardRenderer = (
  context: ProjectBoardIssueCardRenderContext,
) => ReactNode;

interface ProjectBoardAdapterProps {
  participationUserId?: import("../issueParticipation").IssueParticipationViewer;
  parentGroupingEnabled?: boolean;
  emptyState?: ReactNode;
  filterAction?: ReactNode;
  toolbarAction?: ReactNode;
  runtime?: SharedWorkspaceRuntimeApi;
  isIssueRunning?(
    issue: CollaborationIssue,
    bindings: WorkspaceTaskBinding[],
  ): boolean;
  previewDisabled?: boolean;
  onMarkRead?(issue: CollaborationIssue): void;
  translate: CollaborationTranslate;
  boardError: string | null;
  agents: CollaborationAgent[];
  issues: CollaborationIssue[];
  allIssues?: CollaborationIssue[];
  milestones?: readonly Milestone[];
  labels: ProjectBoardAdapterLabels;
  members: CollaborationMember[];
  project: CollaborationProject;
  statuses: CollaborationStatus[];
  taskBindings: WorkspaceTaskBinding[];
  onCreateIssue(): void;
  onCreateUnmatchedIssue?(
    defaults: NonNullable<ReturnType<typeof unmatchedCreateDefaults>>,
  ): void;
  onArchiveCompleted?(issues: CollaborationIssue[]): void;
  onOpenArchive?(): void;
  onSaveViews?(
    config: ProjectBoardViews,
    settings?: import("../project-board/projectBoardViews").BoardViewSaveSettings,
  ): Promise<void>;
  onOpen(issue: CollaborationIssue): void;
  onOpenChildren?(issue: CollaborationIssue): void;
  onCurrentParentIdChange?(parentId: string | null): void;
  onDeleteIssue?(issue: CollaborationIssue): void;
  onMove(
    issue: CollaborationIssue,
    mutation: StandardCloudBoardMutation<CollaborationIssue>,
  ): Promise<void>;
  renderIssueCard?: ProjectBoardIssueCardRenderer;
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
  participationUserId,
  parentGroupingEnabled = false,
  emptyState,
  filterAction,
  toolbarAction,
  runtime,
  isIssueRunning,
  previewDisabled = false,
  translate,
  agents,
  boardError,
  issues,
  allIssues = issues,
  milestones = [],
  labels,
  members,
  onCreateIssue,
  onCreateUnmatchedIssue,
  onArchiveCompleted,
  onOpenArchive,
  onMarkRead,
  onDeleteIssue,
  onSaveViews,
  onMove,
  onOpen,
  onOpenChildren,
  onCurrentParentIdChange,
  project,
  renderIssueCard,
  statuses,
  taskBindings,
}: ProjectBoardAdapterProps) {
  const handlingUserId = participationUserId ?? project.current_user_id;
  const milestonesById = useMemo(
    () => new Map(milestones.map((milestone) => [milestone.id, milestone])),
    [milestones],
  );
  const renderMilestoneMetadata = (
    issue: CollaborationIssue,
    inline = false,
  ) => {
    const milestone =
      issue.can_view_detail !== false && issue.milestone_id
        ? milestonesById.get(issue.milestone_id)
        : undefined;
    return milestone ? (
      <IssueCardMilestone
        itemId={issue.id}
        title={milestone.title}
        label={translate("todo.milestone", "里程碑")}
        inline={inline}
      />
    ) : null;
  };
  const childrenProgress = useMemo(
    () => collectIssueChildrenProgress(allIssues),
    [allIssues],
  );
  const savedViews = useSavedBoardViews({
    projectKey: `${project.project_store}:${project.id}`,
    config: project.board_views,
    revision: project.version,
    translate,
    save: async (config, settings) => {
      if (!onSaveViews) throw new Error(translate("saveFailed"));
      await onSaveViews(config, settings);
    },
  });
  const supportsOrder = ["local", "native", "backend"].includes(
    project.task_provider,
  );
  const canManageViews =
    Boolean(onSaveViews) &&
    (project.project_store === "local" ||
      project.access_role === "Owner" ||
      project.access_role === "Maintainer");
  const runtimeWork = useBrowserBoardRuntimeWork(
    isIssueRunning && renderIssueCard ? undefined : runtime,
    taskBindings,
  );
  const filterScope = `${project.project_store}:${project.id}:${handlingUserId ?? "anonymous"}`;
  const [personalFilter, setPersonalFilter] = useState({
    scope: filterScope,
    enabled: false,
  });
  if (personalFilter.scope !== filterScope) {
    setPersonalFilter({ scope: filterScope, enabled: false });
  }
  const needsMyInput =
    personalFilter.scope === filterScope && personalFilter.enabled;
  const myIssues = useMemo(
    () =>
      issues.filter((issue) => {
        if (handlingUserId == null) return false;
        const bindings = taskBindings.filter(
          (binding) => binding.issueId === issue.id,
        );
        const running = isIssueRunning
          ? isIssueRunning(issue, bindings)
          : bindings.some(
              (binding) =>
                findRuntimeTask(runtimeWork?.work ?? null, {
                  deviceId: binding.deviceId,
                  taskId: binding.taskId,
                })?.running,
            );
        return issueNeedsUser(
          running ? { ...issue, execution_state: "running" } : issue,
          handlingUserId,
        );
      }),
    [issues, handlingUserId, taskBindings, isIssueRunning, runtimeWork?.work],
  );
  const visibleIssues = needsMyInput ? myIssues : issues;
  const availableTags = useMemo(
    () => collectProjectTags(project, issues),
    [project, issues],
  );
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
          noPriority: labels.noPriority,
          noTag: labels.noTag,
          priority: {
            low: "low",
            medium: "medium",
            high: "high",
            urgent: "urgent",
          },
          unassigned: labels.unassigned,
        },
        tags: availableTags,
      }),
    [
      agents,
      issues,
      labels.noPriority,
      labels.noTag,
      labels.unassigned,
      members,
      availableTags,
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
  const tagFilter = useBoardTagFilter({
    scope: `${project.project_store}:${project.id}:${savedViews.view?.id ?? "default"}`,
    tags: availableTags,
    translate,
  });
  const controller = useStandardCloudBoardController({
    classificationProjectId:
      project.resource_type !== "chat_group" &&
      allIssues.some((issue) => issue.group_id)
        ? String(project.id)
        : undefined,
    currentUserId: handlingUserId,
    tagFilter: tagFilter.tags,
    tagLimitError: translate(
      "todo.tag_limit_exceeded",
      "最多添加 20 个不同标签",
    ),
    view: savedViews.view,
    viewScope: `${project.id}:${savedViews.view?.id ?? "default"}`,
    defaultColumnSorts: savedViews.view?.sorts,
    createColumns: (groupBy) =>
      savedViews.view
        ? savedBoardColumns(savedViews.view, statuses, createColumns("status"))
        : createColumns(groupBy),
    defaultGroupBy: project.board_config?.group_by ?? "status",
    extensions,
    focusStorageKey: `collaboration-board-focus:${project.id}`,
    items: visibleIssues,
    hierarchyItems: allIssues,
    onCurrentParentIdChange,
    supportsOrder,
    onMove: async (issue, _column, _beforeItemId, mutation) => {
      try {
        return await onMove(issue, mutation);
      } catch (error) {
        const message = runnerEnvironmentError(error, translate);
        throw message ? new Error(message) : error;
      }
    },
    personalGroupStorageKey:
      project.current_user_id === undefined
        ? null
        : `collaboration-board-group:v1:${project.current_user_id}:${project.project_store}:${project.id}`,
    personalSortStorageKey:
      project.current_user_id != null
        ? `collaboration-board-column-sort:v2:${project.current_user_id}:${project.id}${savedViews.view ? `:view:${savedViews.view.id}` : ""}`
        : null,
  });
  const display = project.card_display ?? {
    show_assignee: true,
    show_priority: true,
    show_tags: true,
    show_date: true,
  };
  const cardLabels = {
    ...createIssueBoardCardLabels(translate),
    statuses: Object.fromEntries(
      statuses.map((status) => [status.id, status.name]),
    ),
  };
  const sensors = useProjectBoardSensors();
  const activeItem = issues.find(
    (issue) => issue.id === controller.activeDragItemId,
  );
  const parentBoard = useParentIssueBoard({
    scope: `${project.current_user_id ?? "anonymous"}:${project.project_store}:${project.id}:${savedViews.view?.id ?? "default"}`,
    enabled: parentGroupingEnabled && supportsOrder,
    items: issues,
    columns: controller.columns,
    currentParentId: controller.currentParentId,
    state: controller.state,
    getColumnItems: controller.getColumnItems,
    translate,
  });

  const layerCount = controller.filteredItems.filter(
    (issue) => issue.parent_id === controller.currentParentId,
  ).length;
  return (
    <div
      data-testid={collaborationTestIds.board}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <ProjectBoardBody<CollaborationIssue>
        translate={translate}
        parentRows={
          parentBoard.active
            ? {
                rows: parentBoard.rows,
                scopeKey: parentBoard.scopeKey,
                translate,
                getParentTitle: (issue) => issue.title,
                getParentKey: (issue) => issue.id,
                renderParentMetadata: (issue) =>
                  renderMilestoneMetadata(issue, true),
                onOpenParent: onOpen,
                onEnterParent: (issue) =>
                  controller.setCurrentParentId(issue.id),
              }
            : undefined
        }
        emptyState={
          issues.length === 0 && !savedViews.view ? emptyState : undefined
        }
        customView={Boolean(savedViews.view)}
        dropFeedback={
          controller.lastMove
            ? {
                ...controller.lastMove,
                message: translate("todo.board_drop_success", undefined, {
                  title:
                    issues.find(
                      (issue) => issue.id === controller.lastMove?.itemId,
                    )?.title ?? "",
                  action:
                    controller.columns.find(
                      (column) => column.key === controller.lastMove?.columnKey,
                    )?.label ?? "",
                }),
              }
            : null
        }
        viewNavigation={
          <BoardViewNavigation
            key={`${project.project_store}:${project.id}`}
            controller={savedViews}
            statuses={statuses}
            tags={availableTags}
            canManage={canManageViews}
            settings={{
              cardDisplay: project.card_display,
              boardConfig: project.board_config,
              canEditStatuses:
                project.resource_type !== "chat_group" &&
                project.task_provider === "local",
            }}
            translate={translate}
          />
        }
        filterAction={
          <>
            {handlingUserId != null && (
              <button
                type="button"
                data-testid="project-needs-my-input-filter"
                aria-pressed={needsMyInput}
                className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-focus max-md:h-11 ${needsMyInput ? "border-text-primary/30 bg-muted text-text-primary" : "border-border bg-background text-text-secondary"}`}
                onClick={() =>
                  setPersonalFilter({
                    scope: filterScope,
                    enabled: !needsMyInput,
                  })
                }
              >
                {translate("todo.home_my_todos")}
                <span>{myIssues.length}</span>
              </button>
            )}
            {tagFilter.control}
            {filterAction}
          </>
        }
        toolbarAction={
          <>
            {parentBoard.toggle}
            {toolbarAction}
          </>
        }
        viewNotice={
          <BoardViewNotice
            controller={savedViews}
            statuses={statuses}
            translate={translate}
          />
        }
        state={controller.state}
        activeDragItemId={controller.activeDragItemId}
        boardError={
          boardError ?? controller.moveError ?? runtimeWork?.error ?? null
        }
        boardItemsLoading={false}
        breadcrumb={controller.breadcrumb}
        columns={controller.columns}
        currentParent={controller.currentParent}
        currentParentId={controller.currentParentId}
        dnd={projectBoardDnd}
        dndContextProps={{
          sensors,
          collisionDetection: projectBoardCollisionDetection,
          onDragStart: (
            event: Pick<Parameters<typeof projectBoardDrop>[0], "active">,
          ) => {
            controller.setActiveSourceColumnKey(
              event.active.data.current?.columnKey ?? null,
            );
            controller.setActiveDragItemId(
              projectBoardDragItemId(event.active),
            );
          },
          onDragCancel: () => controller.setActiveDragItemId(null),
          onDragEnd: (event: Parameters<typeof projectBoardDrop>[0]) => {
            controller.setActiveDragItemId(null);
            if (
              issues.some(
                (issue) =>
                  issue.id === projectBoardDragItemId(event.active) &&
                  canEditCollaborationIssue(issue),
              )
            )
              controller.moveDroppedItem(projectBoardDrop(event));
          },
        }}
        externalGroupLabel=""
        externalGroupValues={[]}
        externalManagedLabel=""
        externalSearchPlaceholder=""
        focusLabels={{
          enter: translate("todo.focus_view_description"),
          exit: translate("todo.exit_focus_view_description"),
          title: translate("todo.focus_view"),
        }}
        sortLabels={
          supportsOrder ? createProjectBoardSortLabels(translate) : undefined
        }
        getColumnDragHint={(column) =>
          activeItem
            ? boardDropHint(
                activeItem,
                column,
                controller.columns.find(
                  (source) => source.key === controller.activeSourceColumnKey,
                ),
                controller.state.groupBy,
                translate,
              )
            : undefined
        }
        getColumnEmptyState={(column) => ({
          hint: labels.noIssues,
          ...((column.type ?? controller.state.groupBy) === "status" &&
          column.status === "inbox" &&
          (!controller.currentParentId ||
            (controller.currentParent &&
              controller.currentParent.can_view_detail !== false &&
              onCreateUnmatchedIssue))
            ? {
                action: {
                  ariaLabel: translate(
                    "todo.board_create_in_column",
                    undefined,
                    {
                      column: column.label,
                    },
                  ),
                  label: translate("todo.board_create_first"),
                  onClick: () => {
                    if (controller.currentParent && onCreateUnmatchedIssue) {
                      onCreateUnmatchedIssue({
                        status: column.status ?? "inbox",
                        tags: [],
                        parent: controller.currentParent,
                        draftScope: `board-column:${column.key}:${controller.currentParent.id}`,
                      });
                    } else {
                      onCreateIssue();
                    }
                  },
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
        layerCount={layerCount}
        onBreadcrumbSelect={controller.setCurrentParentId}
        onSaveGlobalGroupBy={() => undefined}
        renderDragOverlay={() =>
          activeItem ? (
            <ProjectBoardDragOverlay>
              <IssueBoardCardContent
                item={activeItem}
                unread={false}
                reference={`${project.project_key}-${activeItem.sequence_number}`}
                display={{
                  showAssignee: display.show_assignee,
                  showDate: display.show_date,
                  showPriority: display.show_priority,
                  showTags: display.show_tags,
                }}
                labels={cardLabels}
                translate={translate}
              />
            </ProjectBoardDragOverlay>
          ) : null
        }
        renderExternalGroupPicker={() => null}
        renderGroupPicker={(value, onChange) => (
          <ProjectBoardGroupPicker
            fields={[
              { id: "status", name: labels.groupStatus, type: "status" },
              {
                id: "priority",
                name: labels.groupPriority,
                type: "singleSelect",
              },
              { id: "assignee", name: labels.groupAssignee, type: "user" },
              { id: "tag", name: labels.groupTag, type: "tag" },
            ]}
            value={value}
            onChange={(id) => onChange(id as ProjectBoardGroupBy)}
            testIdPrefix="cloud-board-group"
            searchPlaceholder={translate("board.group.search", "搜索分组字段")}
            chooseLabel={translate("board.group.choose", "选择分组字段")}
            emptyLabel={translate("board.group.empty", "没有匹配字段")}
          />
        )}
        renderBoardSettingsAction={
          onOpenArchive
            ? () => (
                <button
                  type="button"
                  className="h-8 shrink-0 rounded-lg border border-border bg-background px-3 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
                  data-testid={collaborationTestIds.issueArchiveOpen}
                  onClick={onOpenArchive}
                >
                  {translate("todo.archive_box", "已归档")}
                </button>
              )
            : undefined
        }
        renderColumnHeaderActions={(column, columnItems, state) => {
          if (
            column.type === "unmatched" &&
            savedViews.view &&
            onCreateUnmatchedIssue
          ) {
            if (controller.currentParentId && !controller.currentParent)
              return null;
            const defaults = unmatchedCreateDefaults(
              savedViews.view,
              statuses,
              controller.currentParent,
            );
            return defaults ? (
              <button
                type="button"
                data-testid={`cloud-todo-column-add-${column.key}`}
                className="flex min-h-11 items-center rounded-md px-2 text-xs text-text-muted hover:bg-background hover:text-text-primary md:h-6 md:min-h-0"
                onClick={() => onCreateUnmatchedIssue(defaults)}
              >
                {translate("todo.board_view_create_unmatched")}
              </button>
            ) : null;
          }
          if (
            (column.type ?? state.groupBy) !== "status" ||
            column.status !== "completed" ||
            !onArchiveCompleted
          ) {
            return null;
          }
          const editableCompletedItems = columnItems.filter((issue) =>
            canEditCollaborationIssue(issue),
          );
          const selectedIds = new Set(
            editableCompletedItems.map((issue) => issue.id),
          );
          const archiveRoots = editableCompletedItems.filter(
            (issue) => !issue.parent_id || !selectedIds.has(issue.parent_id),
          );
          return archiveRoots.length > 0 ? (
            <button
              type="button"
              className="flex h-6 items-center rounded-md px-2 text-xs text-text-muted opacity-0 transition hover:bg-background hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100"
              data-testid={collaborationTestIds.issueArchiveCompleted}
              onClick={() => onArchiveCompleted(archiveRoots)}
            >
              {translate("todo.archive_completed_tasks", "归档已完成任务")}
            </button>
          ) : null;
        }}
        renderItem={(issue, column) => {
          const focused =
            controller.state.focusExecutionColumns &&
            isExecutionBoardColumn(column, controller.state.groupBy);
          const issueDisplay = {
            showAssignee: display.show_assignee,
            showDate: display.show_date,
            showPriority: display.show_priority,
            showTags: display.show_tags,
          };
          const metadata = (
            <>
              {issue.group_id &&
              issue.group_id !== project.id &&
              issue.group_name ? (
                <span
                  data-testid={`thread-source-group-${issue.id}`}
                  className="block truncate text-xs text-text-muted"
                  title={issue.group_name}
                >
                  # {issue.group_name}
                </span>
              ) : null}
              {renderMilestoneMetadata(issue)}
            </>
          );
          const cardProps = {
            metadata,
            translate,
            item: issue,
            unread: false,
            reference: `${project.project_key}-${issue.sequence_number}`,
            labels: cardLabels,
            display: issueDisplay,
            onMarkRead: onMarkRead ? () => onMarkRead(issue) : undefined,
            onArchive:
              onDeleteIssue &&
              issue.status === "completed" &&
              canEditCollaborationIssue(issue)
                ? () => onDeleteIssue(issue)
                : undefined,
            archiveLabel: translate("todo.archive_issue", "归档任务"),
            articleTestId: collaborationTestIds.issue(issue.id),
            dragEnabled: canEditCollaborationIssue(issue),
            onOpen: () => onOpen(issue),
          };
          const progress = childrenProgress.get(issue.id);
          const childrenAction =
            progress && issue.can_view_detail !== false ? (
              <IssueChildrenProgress
                itemId={issue.id}
                progress={progress}
                translate={translate}
                onOpen={() => {
                  onOpenChildren?.(issue);
                  controller.setCurrentParentId(issue.id);
                }}
              />
            ) : null;
          const defaultCard = (
            <IssueBoardCard {...cardProps} childrenAction={childrenAction} />
          );
          return renderIssueCard ? (
            renderIssueCard({
              column,
              defaultCard,
              metadata,
              childrenAction,
              display: issueDisplay,
              focused,
              issue,
              onOpen: () => onOpen(issue),
              onDelete: cardProps.onArchive,
              previewDisabled,
              taskBindings: taskBindings.filter(
                (binding) => binding.issueId === issue.id,
              ),
            })
          ) : runtime ? (
            <BrowserIssueBoardCard
              {...cardProps}
              runtime={runtime}
              work={runtimeWork?.work ?? null}
              taskBindings={taskBindings.filter(
                (binding) => binding.issueId === issue.id,
              )}
              focused={focused}
              previewDisabled={previewDisabled}
              childrenAction={childrenAction}
            />
          ) : (
            defaultCard
          );
        }}
        renderSkeleton={() => null}
        rootLabel={translate("todo.thread_label")}
        rootUnitLabel={translate(
          layerCount === 1
            ? "todo.board_issue_unit_one"
            : "todo.board_issue_unit",
        )}
        saveGlobalDisabled
        saveGlobalLabel=""
        searchPlaceholder={labels.search}
        showQuickStart={false}
        showSaveGlobal={false}
      />
    </div>
  );
}
