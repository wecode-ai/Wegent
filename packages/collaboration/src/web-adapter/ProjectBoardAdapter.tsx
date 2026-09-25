import {
  projectBoardDnd,
  projectBoardCollisionDetection,
  projectBoardDrop,
  useProjectBoardSensors,
} from "../project-board/projectBoardDnd";
import { ProjectBoardDragOverlay } from "../project-board/ProjectBoardDragOverlay";
import { BrowserIssueBoardCard } from "../issue-card/BrowserIssueBoardCard";
import { useBrowserBoardRuntimeWork } from "./useBrowserBoardRuntimeWork";
import type { SharedWorkspaceRuntimeApi } from "../ports/SharedWorkspaceApi";
import type { CollaborationTranslate } from "../i18n";
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, type ReactNode } from "react";

import {
  IssueBoardCard,
  IssueBoardCardContent,
  createIssueBoardCardLabels,
} from "../issue-card";
import {
  createStandardCloudBoardColumns,
  ProjectBoardBody,
  ProjectBoardGroupPicker,
  useStandardCloudBoardController,
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
  runtime?: SharedWorkspaceRuntimeApi;
  previewDisabled?: boolean;
  onMarkRead?(issue: CollaborationIssue): void;
  translate: CollaborationTranslate;
  boardError: string | null;
  agents: CollaborationAgent[];
  issues: CollaborationIssue[];
  labels: ProjectBoardAdapterLabels;
  members: CollaborationMember[];
  project: CollaborationProject;
  statuses: CollaborationStatus[];
  taskBindings: WorkspaceTaskBinding[];
  onCreateIssue(): void;
  onOpenBoardSettings?(): void;
  onGroupByChange(groupBy: ProjectBoardGroupBy): Promise<void>;
  onOpen(issue: CollaborationIssue): void;
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
  runtime,
  previewDisabled = false,
  translate,
  agents,
  boardError,
  issues,
  labels,
  members,
  onCreateIssue,
  onMarkRead,
  onDeleteIssue,
  onOpenBoardSettings,
  onGroupByChange,
  onMove,
  onOpen,
  project,
  renderIssueCard,
  statuses,
  taskBindings,
}: ProjectBoardAdapterProps) {
  const runtimeWork = useBrowserBoardRuntimeWork(
    renderIssueCard ? undefined : runtime,
    taskBindings,
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
        tags: project.tags,
      }),
    [
      agents,
      issues,
      labels.noPriority,
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
  const cardLabels = createIssueBoardCardLabels(translate);
  const sensors = useProjectBoardSensors();
  const activeItem = issues.find(
    (issue) => issue.id === controller.activeDragItemId,
  );

  return (
    <div
      data-testid={collaborationTestIds.board}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <ProjectBoardBody<CollaborationIssue>
        state={controller.state}
        activeDragItemId={controller.activeDragItemId}
        boardError={boardError ?? runtimeWork?.error ?? null}
        boardItemsLoading={false}
        breadcrumb={controller.breadcrumb}
        columns={controller.columns}
        currentParent={controller.currentParent}
        currentParentId={controller.currentParentId}
        dnd={projectBoardDnd}
        dndContextProps={{
          sensors,
          collisionDetection: projectBoardCollisionDetection,
          onDragStart: (event: { active: { id: string | number } }) =>
            controller.setActiveDragItemId(String(event.active.id)),
          onDragCancel: () => controller.setActiveDragItemId(null),
          onDragEnd: (event: Parameters<typeof projectBoardDrop>[0]) => {
            controller.setActiveDragItemId(null);
            if (
              issues.some(
                (issue) =>
                  issue.id === String(event.active.id) &&
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
          enter: "展开进行中与待确认列",
          exit: "退出执行阶段专注视图",
          title: "专注视图",
        }}
        getColumnDragHint={(column) =>
          controller.activeDragItemId ? `移到这里：${column.label}` : undefined
        }
        getColumnEmptyState={(column) => ({
          hint: labels.noIssues,
          ...(controller.state.groupBy === "status" && column.status === "inbox"
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
        renderDragOverlay={() =>
          activeItem ? (
            <ProjectBoardDragOverlay>
              <IssueBoardCardContent
                item={activeItem}
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
          onOpenBoardSettings
            ? () => (
                <button
                  type="button"
                  className="h-8 shrink-0 rounded-lg border border-border bg-background px-3 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
                  data-testid="collaboration-board-settings"
                  onClick={onOpenBoardSettings}
                >
                  看板设置
                </button>
              )
            : undefined
        }
        renderItem={(issue, column) => {
          const issueDisplay = {
            showAssignee: display.show_assignee,
            showDate: display.show_date,
            showPriority: display.show_priority,
            showTags: display.show_tags,
          };
          const cardProps = {
            translate,
            item: issue,
            reference: `${project.project_key}-${issue.sequence_number}`,
            labels: cardLabels,
            display: issueDisplay,
            onMarkRead: onMarkRead ? () => onMarkRead(issue) : undefined,
            onArchive:
              onDeleteIssue && canEditCollaborationIssue(issue)
                ? () => onDeleteIssue(issue)
                : undefined,
            archiveLabel: translate("todo.delete_issue", "删除任务"),
            articleTestId: collaborationTestIds.issue(issue.id),
            dragEnabled: canEditCollaborationIssue(issue),
            onOpen: () => onOpen(issue),
          };
          const childrenAction = issues.some(
            (candidate) => candidate.parent_id === issue.id,
          ) ? (
            <button
              type="button"
              data-testid={`collaboration-issue-children-${issue.id}`}
              onClick={() => controller.setCurrentParentId(issue.id)}
              className="mx-3 mb-3 text-xs text-text-secondary hover:text-text-primary"
            >
              查看子任务
            </button>
          ) : null;
          const defaultCard = (
            <IssueBoardCard {...cardProps} childrenAction={childrenAction} />
          );
          return renderIssueCard ? (
            renderIssueCard({
              column,
              defaultCard,
              display: issueDisplay,
              focused: controller.state.focusExecutionColumns,
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
              focused={controller.state.focusExecutionColumns}
              previewDisabled={previewDisabled}
              childrenAction={childrenAction}
            />
          ) : (
            defaultCard
          );
        }}
        renderSkeleton={() => null}
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
